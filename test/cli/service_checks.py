"""Real runner -> npm-like child -> compiler-like grandchild; isolated Unix groups only."""
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

project = Path(sys.argv[1])
node = sys.argv[2]
loader = project / 'node_modules/tsx/dist/loader.mjs'


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


with tempfile.TemporaryDirectory(prefix='hse-cli-service-') as directory:
    root = Path(directory)
    # No real environment, credentials, service locks, or Telegram processes are used.
    environment = {key: value for key, value in os.environ.items() if not key.startswith(('TELEGRAM_', 'YANDEX_', 'ICLOUD_', 'GOOGLE_', 'STUDY_'))}
    environment.update(DOTENV_CONFIG_PATH=str(root / 'empty.env'), STUDY_CONFIG=str(root / 'config.json'), STUDY_DATA_DIR=str(root / 'data'), STUDY_SECRETS_DIR=str(root / 'secrets'))

    for name, value in [('SIGINT', signal.SIGINT), ('SIGTERM', signal.SIGTERM)]:
        child_record = root / (name + '-child.json')
        grand_record = root / (name + '-grandchild.json')
        grand_script = root / (name + '-grandchild.mjs')
        grand_script.write_text("""
import {writeFileSync} from 'node:fs';
let count=0;
const heartbeat=setInterval(()=>{},1000);
const stop=signal=>{
  count++;
  writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,signal,count}));
  if(count===1)setTimeout(()=>{clearInterval(heartbeat);process.exit(0);},100);
};
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
console.log('GRAND_READY:'+process.pid);
""")
        child_script = root / (name + '-child.mjs')
        child_script.write_text("""
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const grand=spawn(process.execPath,[process.argv[2],process.argv[4]],{stdio:'inherit'});
let count=0,requested=false,grandExited=false;
const heartbeat=setInterval(()=>{},1000);
const finish=()=>{if(requested&&grandExited)setTimeout(()=>{clearInterval(heartbeat);process.exit(0);},50);};
grand.on('exit',(code,killedBy)=>{
  if(code!==0||killedBy)process.exit(7);
  grandExited=true;finish();
});
const stop=signal=>{
  count++;requested=true;
  writeFileSync(process.argv[3],JSON.stringify({pid:process.pid,signal,count}));
  finish();
};
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
console.log('CHILD_READY:'+process.pid);
""")
        arguments = [str(child_script), str(grand_script), str(child_record), str(grand_record)]
        runner = "import {runProcess} from " + json.dumps(str(project / 'src/cli/service.ts')) + "; const code=await runProcess(process.execPath," + json.dumps(arguments) + ",process.cwd());console.log('RUNNER_EXIT:'+code);process.exitCode=code;"
        process = subprocess.Popen([node, '--import', str(loader), '--input-type=module', '-e', runner], cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        output = b''
        fixture_group = None
        completed = False
        try:
            end = time.monotonic() + 8
            while b'GRAND_READY:' not in output and time.monotonic() < end:
                ready, _, _ = select.select([process.stdout], [], [], 0.1)
                if ready:
                    output += os.read(process.stdout.fileno(), 65536)
                if b'CHILD_READY:' in output and b'\n' in output.split(b'CHILD_READY:', 1)[1]:
                    fixture_group = int(output.split(b'CHILD_READY:', 1)[1].splitlines()[0])
                if process.poll() is not None:
                    break
            assert b'GRAND_READY:' in output, output.decode(errors='replace')
            fixture_group = int(output.split(b'CHILD_READY:')[1].splitlines()[0])
            os.kill(process.pid, value)
            # A repeated interruption while shutdown is pending must not be forwarded again.
            time.sleep(0.025)
            os.kill(process.pid, value)
            remaining, _ = process.communicate(timeout=8)
            output += remaining
            assert process.returncode == 0, output.decode(errors='replace')
            assert b'RUNNER_EXIT:0' in output, output.decode(errors='replace')
            child = json.loads(child_record.read_text())
            grand = json.loads(grand_record.read_text())
            assert child['signal'] == name and grand['signal'] == name
            assert child['count'] == 1 and grand['count'] == 1
            assert not alive(child['pid']) and not alive(grand['pid']), 'Runner returned with a surviving fixture descendant'
            completed = True
        finally:
            # These process groups belong solely to fixtures created above. Never touch the real bot.
            if fixture_group is not None and not completed:
                try:
                    os.killpg(fixture_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)

print('PASS CLI SERVICE SIGNALS: SIGINT/SIGTERM reach child and grandchild once; runner awaits graceful exit')
