'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexJsonl } = require('../src/history-adapters');
const { extractInvocations } = require('../src/auto-learn');

function transcript(args, nested = false) {
  const payloads = nested ? [
    { type: 'custom_tool_call', name: 'exec', call_id: 'shell-call',
      input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);` },
    { type: 'custom_tool_call_output', call_id: 'shell-call', output: 'Exit code: 0' },
  ] : [
    { type: 'function_call', name: 'exec_command', call_id: 'shell-call', arguments: JSON.stringify(args) },
    { type: 'function_call_output', call_id: 'shell-call', output: { exit_code: 0 } },
  ];
  return payloads.map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n');
}

test('Codex explicit Bash on Windows keeps escaped semicolons inside one argument', () => {
  for (const nested of [false, true]) {
    const [observation] = parseCodexJsonl(transcript({ cmd: 'rg foo\\;bar', shell: 'C:\\tools\\bash.exe' }, nested),
      { platform: 'win32' });
    assert.ok(observation, `WITNESS ${nested ? 'nested' : 'direct'} shell call was observed`);
    const invocations = extractInvocations(observation.tool, observation.command, observation);
    assert.deepEqual(invocations.map((item) => item.argv), [['rg', 'foo;bar']],
      'WITNESS the PowerShell fallback splits an escaped Bash semicolon into a false second command');
    assert.equal(observation.tool, 'Bash');
    assert.equal(observation.status, 'success');
  }
});

test('Codex explicit shell names and paths override host defaults in either argument order', () => {
  const cases = [
    ['bash', 'win32', 'Bash'], ['/bin/bash', 'win32', 'Bash'],
    ['powershell', 'linux', 'PowerShell'], ['PowerShell.EXE', 'linux', 'PowerShell'],
    ['pwsh', 'linux', 'PowerShell'], ['/opt/microsoft/powershell/7/pwsh', 'linux', 'PowerShell'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'linux', 'PowerShell'],
  ];
  for (const [shell, platform, expected] of cases) {
    for (const nested of [false, true]) {
      for (const args of [{ shell, cmd: 'git status' }, { cmd: 'git status', shell }]) {
        const [observation] = parseCodexJsonl(transcript(args, nested), { platform });
        assert.equal(observation?.tool, expected, `${shell}, nested=${nested}, keys=${Object.keys(args)}`);
      }
    }
  }
});

test('Codex defaults remain unchanged only when the shell is absent', () => {
  for (const nested of [false, true]) {
    assert.equal(parseCodexJsonl(transcript({ cmd: 'git status' }, nested), { platform: 'win32' })[0].tool, 'PowerShell');
    assert.equal(parseCodexJsonl(transcript({ cmd: 'git status' }, nested), { platform: 'linux' })[0].tool, 'Bash');
    assert.equal(parseCodexJsonl(transcript({ cmd: 'git status' }, nested), { platform: 'win32', tool: 'Bash' })[0].tool, 'Bash');
    for (const shell of ['cmd', 'C:\\Windows\\System32\\cmd.exe', 'evilbash', '/bin/zsh', '/bin/bash -l', '', null, 42]) {
      assert.deepEqual(parseCodexJsonl(transcript({ cmd: 'git status', shell }, nested), { platform: 'win32' }), [],
        `unsupported explicit shell ${JSON.stringify(shell)} must not become PowerShell evidence`);
    }
  }
});

test('dynamic or overridden nested shell expressions cannot borrow the host grammar', () => {
  for (const properties of [
    'cmd: "git status", shell: selectedShell',
    'cmd: "git status", shell',
    'cmd: "git status", shell: "bash" + suffix',
    'cmd: "git status", shell: `ba${suffix}sh`',
    'cmd: "git status", [shellKey]: "bash"',
    'cmd: "git status", ...options',
    'cmd: "git status", shell: "bash", shell: selectedShell',
  ]) {
    const input = `const result = await tools.exec_command({ ${properties} }); text(result);`;
    const text = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'dynamic', input },
      { type: 'custom_tool_call_output', call_id: 'dynamic', output: 'Exit code: 0' },
    ].map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n');
    assert.deepEqual(parseCodexJsonl(text, { platform: 'win32' }), [], properties);
  }
});

test('one supported call cannot receive success from a batch containing an unsupported shell', () => {
  for (const shell of ['"cmd.exe"', 'selectedShell']) {
    const input = 'const first = await tools.exec_command({ cmd: "git status", shell: "bash" }); '
      + `const second = await tools.exec_command({ cmd: "dir", shell: ${shell} }); text(second);`;
    const text = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'mixed', input },
      { type: 'custom_tool_call_output', call_id: 'mixed', output: 'Exit code: 0' },
    ].map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n');
    const observations = parseCodexJsonl(text, { platform: 'win32' });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].command, 'git status');
    assert.equal(observations[0].status, 'unknown', 'an unattributable success must remain unknown');
  }
});

test('outer script completion does not credit a shell process that is still running', () => {
  for (const output of [
    JSON.stringify({ session_id: 731, output: 'working', wall_time_seconds: 1 }),
    JSON.stringify({ session_id: 731, exit_code: null, output: 'working' }),
    'Process running with session ID 731\nOutput:\nworking',
  ]) {
    const text = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'running',
        input: 'const result = await tools.exec_command({ cmd: "git status" }); text(result);' },
      { type: 'custom_tool_call_output', call_id: 'running', output: [
        { type: 'text', text: 'Script completed\nWall time: 1.1 seconds' },
        { type: 'text', text: output },
      ] },
    ].map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n');
    const [observation] = parseCodexJsonl(text, { platform: 'win32' });
    assert.equal(observation.status, 'unknown', 'a returned session ID is not a successful process exit');
  }
});

test('a terminal shell result may retain its session ID without losing its outcome', () => {
  for (const [exit_code, status] of [[0, 'success'], [2, 'failed']]) {
    const text = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'terminal',
        input: 'const result = await tools.exec_command({ cmd: "git status" }); text(result);' },
      { type: 'custom_tool_call_output', call_id: 'terminal', output: [
        { type: 'text', text: 'Script completed\nWall time: 1.1 seconds' },
        { type: 'text', text: JSON.stringify({ session_id: 731, exit_code,
          output: 'Process running with session ID 999' }) },
      ] },
    ].map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n');
    assert.equal(parseCodexJsonl(text, { platform: 'win32' })[0].status, status,
      'the process exit is authoritative; stdout text is not another running process');
  }
});
