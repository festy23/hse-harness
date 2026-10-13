"""Configure a real installed CLI through its terminal; no account connections."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

executable, directory = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 90, 0, 0))

def terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

environment = dict(os.environ, TERM='xterm-256color')
process = subprocess.Popen(['node', executable, 'profile'], cwd=directory, env=environment, stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
os.close(slave)
pending = b''
output = b''
try:
    for prompt, answer in [
        ('Как тебя зовут?', 'Тестовый пользователь'), ('Вуз / факультет', ''),
        ('Образовательная программа', 'ПМИ'), ('Учебная группа', 'Тестовая группа'),
        ('Курс', '2'), ('Учебный год', ''), ('Предметы через запятую', 'Алгебра'),
        ('Поток, майнор, НИС', ''),
    ]:
        target = prompt.encode()
        end = time.monotonic() + 8
        while target not in pending and time.monotonic() < end:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                data = os.read(master, 65536)
                pending += data
                output += data
        assert target in pending, output.decode(errors='replace')
        pending = pending.split(target, 1)[1]
        os.write(master, (answer + '\r').encode())
    end = time.monotonic() + 8
    while process.poll() is None and time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                output += os.read(master, 65536)
            except OSError:
                pass
    assert process.poll() is not None, output.decode(errors='replace')
    assert process.returncode == 0, output.decode(errors='replace')
    print('PASS installed CLI: actual profile saved through terminal prompts')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
