#!/usr/bin/env python3
"""
PTY helper for cc-daemon embedded terminal.

Spawns a command inside a real PTY and proxies I/O via stdin/stdout so that
Node.js can drive it without needing node-pty or any native bindings.

Protocol (stdin → PTY):
  - Regular bytes are forwarded verbatim to the PTY master.
  - Resize command: \x01{cols}x{rows}\n  (e.g. b'\x01220x50\n')
    Resizes the PTY and sends SIGWINCH to the child.

Protocol (PTY → stdout):
  - Raw terminal bytes (ANSI sequences included) written directly to stdout.

Usage:
  python3 pty_helper.py <cols> <rows> <cmd> [args...]
"""

import sys
import os
import pty
import select
import struct
import termios
import fcntl
import signal


def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write('usage: pty_helper.py <cols> <rows> <cmd> [args...]\n')
        sys.exit(1)

    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    cmd_args = sys.argv[3:]

    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, cols, rows)

    pid = os.fork()
    if pid == 0:
        # Child: become a new session leader with the slave PTY as controlling terminal
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave_fd, fd)
        os.close(master_fd)
        if slave_fd > 2:
            os.close(slave_fd)
        os.execvp(cmd_args[0], cmd_args)
        os._exit(1)

    os.close(slave_fd)

    # Make master non-blocking so reads don't hang
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    stdin_fd = sys.stdin.buffer.fileno()
    stdout_fd = sys.stdout.buffer.fileno()

    # Buffer for incomplete resize commands arriving across read boundaries
    pending = b''

    while True:
        try:
            r, _, _ = select.select([master_fd, stdin_fd], [], [], 0.05)
        except (KeyboardInterrupt, SystemExit):
            break

        for fd in r:
            if fd == master_fd:
                try:
                    data = os.read(master_fd, 4096)
                    if data:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                except OSError:
                    sys.exit(0)

            elif fd == stdin_fd:
                try:
                    data = os.read(stdin_fd, 4096)
                except OSError:
                    sys.exit(0)
                if not data:
                    sys.exit(0)

                data = pending + data
                pending = b''

                # Scan for resize escape: \x01{cols}x{rows}\n
                while True:
                    idx = data.find(b'\x01')
                    if idx == -1:
                        # No resize marker — forward everything
                        if data:
                            try:
                                os.write(master_fd, data)
                            except OSError:
                                sys.exit(0)
                        data = b''
                        break

                    # Forward bytes before the marker
                    if idx > 0:
                        try:
                            os.write(master_fd, data[:idx])
                        except OSError:
                            sys.exit(0)
                    data = data[idx + 1:]

                    # Find the newline terminating the resize command
                    nl = data.find(b'\n')
                    if nl == -1:
                        # Incomplete — buffer and wait for more
                        pending = b'\x01' + data
                        data = b''
                        break

                    cmd = data[:nl].decode('ascii', errors='ignore')
                    data = data[nl + 1:]

                    if 'x' in cmd:
                        try:
                            c, r2 = cmd.split('x', 1)
                            set_winsize(master_fd, int(c), int(r2))
                            os.kill(pid, signal.SIGWINCH)
                        except Exception:
                            pass

        # Reap child if it has exited
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                break
        except ChildProcessError:
            break

    try:
        os.close(master_fd)
    except OSError:
        pass


if __name__ == '__main__':
    main()
