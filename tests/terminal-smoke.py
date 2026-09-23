#!/usr/bin/env python3
"""Local PTY smoke test. Isolated config, no provider credentials or model prompts."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
if not NODE:
    raise SystemExit('node must be on PATH')
CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def smoke(columns, rows, mode, truecolor):
    with tempfile.TemporaryDirectory(prefix='pi-workstation-smoke-') as directory:
        home = Path(directory)
        project = home / 'project'
        project.mkdir()
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': directory,
            'XDG_CONFIG_HOME': str(home / 'config'),
            'XDG_CACHE_HOME': str(home / 'cache'),
            'PI_CODING_AGENT_DIR': str(home / 'agent'),
            'PI_OFFLINE': '1',
            'PI_TELEMETRY': '0',
            'PI_TRUE_COLOR': '1' if truecolor else '0',
            'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8',
        }
        if os.environ.get('PI_WORKSTATION_PI_ROOT'):
            env['PI_WORKSTATION_PI_ROOT'] = os.environ['PI_WORKSTATION_PI_ROOT']
        argv = [
            NODE, str(ROOT / 'scripts/launch.mjs'), '--project', str(project),
            '--no-approve', '--no-session', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--no-themes', '--tui-mode', mode,
        ]
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            os.execve(NODE, argv, env)
        output = bytearray()
        reaped = False

        def receive(timeout):
            if not select.select([fd], [], [], timeout)[0]:
                return
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            output.extend(chunk)
            if b'\x1b[6n' in chunk:
                os.write(fd, b'\x1b[1;1R')

        def text(start=0):
            return CSI.sub('', OSC.sub('', bytes(output[start:]).decode('utf8', errors='replace')))

        def expect(needle, start=0, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if needle in text(start):
                    return
                receive(min(0.2, max(0, deadline - time.monotonic())))
            raise AssertionError(f'{mode} {columns}x{rows}: missing {needle!r}\n{text()[-6000:]}')

        def command(value, expected):
            start = len(output)
            os.write(fd, value.encode() + b'\r')
            expect(expected, start)
            return start

        try:
            expect('PI / WORKSTATION')
            expect('03 / INPUT')
            command('/workstation off', 'Workstation layout off.')
            command('/workstation on', '03 / INPUT')
            command('/workstation compact', 'Workstation layout: compact')
            auto_start = command('/workstation auto', 'Workstation layout: auto')
            if mode == 'fullscreen':
                # The header may already fit onscreen: a no-op Home need not emit a redraw.
                os.write(fd, b'\x1b[H')
                expect('PI / WORKSTATION', auto_start)
                os.write(fd, b'\x1b[F')
            # Output marker is not contiguous in the command itself, so this proves execution.
            command("!!printf 'CORE_%s\\n' BASH_OK", 'CORE_BASH_OK')
            command('/reload', 'Reloaded keybindings')
            # Core clears startup content on /new; only the input rail is persistent.
            command('/new', 'New session started')
            start = len(output)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 40, 0, 0))
            os.killpg(pid, signal.SIGWINCH)
            # The TUI may redraw only changed cells, so a resized screen can legitimately reuse
            # the header it already drew; assert it is on screen rather than newly emitted.
            expect('03 / INPUT')
            start = len(output)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            os.killpg(pid, signal.SIGWINCH)
            # The TUI may redraw only changed cells, so a resized screen can legitimately reuse
            # the header it already drew; assert it is on screen rather than newly emitted.
            expect('03 / INPUT')
            os.write(fd, b'/quit\r')
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                receive(0.1)
                found, status = os.waitpid(pid, os.WNOHANG)
                if found:
                    reaped = True
                    assert os.waitstatus_to_exitcode(status) == 0, text()[-6000:]
                    break
            assert reaped, 'Pi did not exit cleanly'
            assert b'\x1b[?2004l' in output, 'Bracketed paste mode was not restored'
            for error_text in ['Failed to load extension', 'Extension error', 'exceeds terminal width']:
                assert error_text not in text(), text()[-6000:]
            print(f'PASS: {mode} {columns}x{rows}, {"truecolor" if truecolor else "256-color"}; '
                  'startup/toggle/bash/reload/new/resize/quit')
        finally:
            if not reaped:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(fd)


for configuration in [(80, 24, 'regular', False), (120, 40, 'regular', True),
                      (80, 24, 'fullscreen', False), (120, 40, 'fullscreen', True)]:
    smoke(*configuration)
