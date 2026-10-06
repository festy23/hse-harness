"""Exercise actual terminal prompts in an isolated POSIX pseudo-terminal; no account calls."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

project = Path(sys.argv[1])
node = sys.argv[2]
loader = project / 'node_modules/tsx/dist/loader.mjs'

class Terminal:
    def __init__(self, root, arguments, columns=72):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, columns, 0, 0))
        environment = {key: value for key, value in os.environ.items() if not key.startswith(('TELEGRAM_', 'YANDEX_', 'ICLOUD_', 'GOOGLE_', 'STUDY_'))}
        environment.update(DOTENV_CONFIG_PATH=str(root / 'empty.env'), STUDY_CONFIG=str(root / 'config.json'), STUDY_DATA_DIR=str(root / 'data'), STUDY_SECRETS_DIR=str(root / 'secrets'), TERM='xterm-256color')
        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        self.process = subprocess.Popen([node, '--import', str(loader), *arguments], cwd=root, env=environment, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
        os.close(slave)
        self.output = b''
        self.pending = b''

    def read(self, timeout=0.1):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if ready:
            try:
                data = os.read(self.master, 65536)
                self.output += data
                self.pending += data
            except OSError:
                pass

    def expect(self, text, timeout=8):
        target = text.encode()
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if target in self.pending:
                self.pending = self.pending.split(target, 1)[1]
                return
            self.read()
            if self.process.poll() is not None:
                break
        raise AssertionError('Missing terminal text: ' + text + '\n' + self.output.decode(errors='replace'))

    def send(self, value):
        os.write(self.master, value.encode())

    def finish(self):
        end = time.monotonic() + 8
        while self.process.poll() is None and time.monotonic() < end:
            self.read()
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            raise AssertionError('Terminal did not exit')
        self.read(0)
        os.close(self.master)
        return self.process.returncode

with tempfile.TemporaryDirectory(prefix='hse-cli-pty-') as directory:
    root = Path(directory)
    cli = str(project / 'scripts/harness.mjs')
    # Fresh menu chooses configure, cancel during a section returns to the menu.
    terminal = Terminal(root, [cli], columns=48)
    terminal.expect('HSE HARNESS')
    terminal.expect('Главное меню')
    terminal.send('\r')
    terminal.expect('Продолжить настройку')
    terminal.send('\r')
    terminal.expect('Как тебя зовут?')
    terminal.send('\x03')
    terminal.expect('Раздел отменён')
    terminal.expect('Главное меню')
    terminal.send('\x03')
    assert terminal.finish() == 0
    assert not (root / 'config.json').exists()
    assert b'Enter: confirm' not in terminal.output

    # Complete a real section through prompts and read the actual persisted result.
    terminal = Terminal(root, [cli, 'profile'])
    for message, answer in [
        ('Как тебя зовут?', 'Тест'), ('Вуз / факультет', ''),
        ('Образовательная программа', 'ПМИ'), ('Учебная группа', 'БПМИ251'),
        ('Курс', '2'), ('Учебный год', ''), ('Предметы через запятую', 'Алгебра'),
        ('Поток, майнор, НИС', ''),
    ]:
        terminal.expect(message)
        terminal.send(answer + '\r')
    assert terminal.finish() == 0
    saved = (root / 'config.json').read_text()
    assert json.loads(saved)['profile']['name'] == 'Тест'
    assert json.loads(saved)['profile']['course'] == 2

    # Cancel editing an already saved profile without changing its file.
    terminal = Terminal(root, [cli, 'profile'])
    terminal.expect('Как тебя зовут?')
    terminal.send('\x03')
    assert terminal.finish() == 0
    assert (root / 'config.json').read_text() == saved

    # Actual secret prompt masks input; test values must never reach terminal output.
    script = "import {terminal} from " + json.dumps(str(project / 'src/cli/terminal.ts')) + "; const value=await terminal.input({message:'Секрет для проверки',secret:true}); console.log('LEN:'+value.length);"
    secret = 'private-test-secret-7343'
    terminal = Terminal(root, ['--input-type=module', '-e', script])
    terminal.expect('Секрет для проверки')
    terminal.send(secret + '\r')
    assert terminal.finish() == 0
    assert secret.encode() not in terminal.output
    assert ('LEN:' + str(len(secret))).encode() in terminal.output

    # Cancelling actual animated progress waits for cleanup and rolls credentials back.
    script = "import {terminal} from " + json.dumps(str(project / 'src/cli/terminal.ts')) + "; import {SetupState} from " + json.dumps(str(project / 'src/cli/state.ts')) + "; import {SetupCancelled} from " + json.dumps(str(project / 'src/cli/errors.ts')) + "; const state=new SetupState(); await state.load(); await state.env('TEST_TOKEN','old'); try { await state.transaction(async()=>{ await state.env('TEST_TOKEN','new'); await terminal.task('Проверка отмены',async()=>{console.log('PROGRESS_READY');await new Promise(r=>setTimeout(r,200));console.log('ACTION_CLEANED');}); state.config.model='must-not-save';}); throw new Error('Cancellation lost'); } catch(error) {if(!(error instanceof SetupCancelled))throw error; console.log('ROLLED_BACK');}"
    terminal = Terminal(root, ['--input-type=module', '-e', script], columns=48)
    terminal.expect('PROGRESS_READY')
    terminal.send('\x03')
    assert terminal.finish() == 0
    assert b'ACTION_CLEANED' in terminal.output
    assert b'ROLLED_BACK' in terminal.output
    assert "TEST_TOKEN='old'" in (root / 'empty.env').read_text()
    assert json.loads((root / 'config.json').read_text())['model'] != 'must-not-save'

    # Ctrl+C while the foreground runner owns a child is forwarded once and awaited.
    child_script = root / 'child.mjs'
    child_script.write_text("console.log('CHILD_READY'); process.once('SIGINT',()=>{console.log('CHILD_STOPPED');setTimeout(()=>process.exit(0),100)}); setInterval(()=>{},1000);")
    runner = "import {runProcess} from " + json.dumps(str(project / 'src/cli/service.ts')) + "; const code=await runProcess(process.execPath,[" + json.dumps(str(child_script)) + "],process.cwd()); console.log('RUNNER_EXIT:'+code);"
    terminal = Terminal(root, ['--input-type=module', '-e', runner])
    terminal.expect('CHILD_READY')
    terminal.send('\x03')
    assert terminal.finish() == 0
    assert b'CHILD_STOPPED' in terminal.output
    assert b'RUNNER_EXIT:0' in terminal.output

print('PASS CLI PTY: narrow menu, section cancel/return, real profile persistence, edit cancellation, masked secret, graceful child shutdown')
