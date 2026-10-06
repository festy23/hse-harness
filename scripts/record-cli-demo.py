#!/usr/bin/env python3
"""Record the real CLI in an isolated POSIX terminal and render its ANSI output to GIF.

Requires Python 3, Pillow and pyte. No account login or external service is used.
"""
import codecs
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont
from wcwidth import wcswidth

PROJECT = Path(__file__).resolve().parent.parent
OUTPUT = PROJECT / 'docs/assets/cli-setup.gif'
COLUMNS, ROWS = 90, 54
EVENTS = []
START = time.monotonic()


class EmojiScreen(pyte.Screen):
    """Keep emoji variation selectors from dropping the rest of a pyte text run."""
    def draw(self, data):
        for char in data:
            if char == '\ufe0f' and self.cursor.x:
                line = self.buffer[self.cursor.y]
                column = self.cursor.x - 1
                if not line[column].data and column:
                    column -= 1
                previous = line[column]
                combined = previous.data + char
                line[column] = previous._replace(data=combined)
                if wcswidth(combined) > wcswidth(previous.data) and self.cursor.x < self.columns:
                    line[self.cursor.x] = self.cursor.attrs._replace(data='')
                    self.cursor.x += 1
            else:
                super().draw(char)


class Terminal:
    def __init__(self, root):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
        # Absolute paths prevent the bootstrap's chdir from loading the owner's files.
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(('TELEGRAM_', 'YANDEX_', 'ICLOUD_', 'GOOGLE_', 'STUDY_', 'DOTENV_'))
            and key not in ('NO_COLOR', 'NODE_DISABLE_COLORS')
        }
        environment.update(
            DOTENV_CONFIG_PATH=str(root / 'empty.env'), STUDY_CONFIG=str(root / 'config.json'),
            STUDY_DATA_DIR=str(root / 'data'), STUDY_SECRETS_DIR=str(root / 'secrets'),
            TERM='xterm-256color', COLORTERM='truecolor', FORCE_COLOR='3',
        )

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [shutil.which('node'), str(PROJECT / 'scripts/harness.mjs')], cwd=root,
            env=environment, stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=controlling_terminal,
        )
        os.close(slave)
        self.pending = b''
        EVENTS.append((time.monotonic() - START, b'\x1b[0m\x1b[2J\x1b[H'))

    def read(self, timeout=0.04):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if ready:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if data:
                self.pending += data
                EVENTS.append((time.monotonic() - START, data))

    def expect(self, text, timeout=12):
        end = time.monotonic() + timeout
        target = text.encode()
        while time.monotonic() < end:
            if target in self.pending:
                self.pending = self.pending.split(target, 1)[1]
                return
            self.read()
        raise RuntimeError('Demo did not reach prompt: ' + text)

    def pause(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.read(min(0.04, end - time.monotonic()))

    def send(self, text):
        os.write(self.master, text.encode())

    def type(self, text):
        for character in text:
            self.send(character)
            self.pause(0.065)
        self.pause(0.28)
        self.send('\r')

    def close(self):
        try:
            if self.process.poll() is None:
                self.send('\x03')
                end = time.monotonic() + 5
                while self.process.poll() is None and time.monotonic() < end:
                    self.read()
                if self.process.poll() is None:
                    os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
            self.read(0)
        finally:
            os.close(self.master)


def record():
    with tempfile.TemporaryDirectory(prefix='hse-cli-demo-') as directory:
        root = Path(directory)
        (root / 'empty.env').write_text('')
        terminal = Terminal(root)
        try:
            terminal.expect('Главное меню')
            first_frame = time.monotonic() - START
            terminal.pause(2.5)
            for _ in range(2):
                terminal.send('\x1b[B')
                terminal.pause(0.35)
            terminal.send('\r')
            for prompt, answer in [
                ('Как тебя зовут?', 'Анна'),
                ('Вуз / факультет', ''),
                ('Образовательная программа', 'Прикладная математика'),
                ('Учебная группа', 'БПМИ251'),
                ('Курс', '2'),
                ('Учебный год', ''),
                ('Предметы через запятую', 'Алгебра, Математический анализ'),
                ('Поток, майнор, НИС', ''),
            ]:
                terminal.expect(prompt)
                terminal.pause(0.3)
                terminal.type(answer)
            terminal.expect('— сохранено')
            terminal.expect('Главное меню')
            terminal.pause(1.5)
        finally:
            terminal.close()
        saved = json.loads((root / 'config.json').read_text())
        assert saved['profile']['name'] == 'Анна' and saved['profile']['course'] == 2
        assert not saved['chats'] and not saved['ownerId']
        # Reopen the actual menu to show the persisted profile and its green check.
        terminal = Terminal(root)
        try:
            terminal.expect('Сохранено 1/5')
            terminal.expect('Главное меню')
            terminal.pause(3)
        finally:
            terminal.close()
    return first_frame, time.monotonic() - START


def render(first_frame, duration):
    font_path = os.environ.get('HSE_DEMO_FONT', '/System/Library/Fonts/Menlo.ttc')
    font = ImageFont.truetype(font_path, 14)
    emoji_path = Path('/System/Library/Fonts/Apple Color Emoji.ttc')
    emoji_font = ImageFont.truetype(str(emoji_path), 32) if emoji_path.exists() else None
    emoji_cache = {}
    cell_width, cell_height, left, top = 9, 19, 24, 50
    width, height = COLUMNS * cell_width + 48, ROWS * cell_height + 70
    background, foreground = '#0d1523', '#e5edf8'
    ansi = dict(zip(
        ['black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'white',
         'brightblack', 'brightred', 'brightgreen', 'brightbrown', 'brightblue',
         'brightmagenta', 'brightcyan', 'brightwhite'],
        ['#243349', '#ff707f', '#72dca6', '#e6ca7b', '#6eabff', '#c9a4ff', '#81d6e5', '#e5edf8',
         '#8091a9', '#ff929c', '#8beab9', '#f5df9e', '#91c2ff', '#ddc2ff', '#a1edf8', '#ffffff'],
    ))

    def color(value, default):
        return default if value == 'default' else ansi.get(value, '#' + value)

    screen = EmojiScreen(COLUMNS, ROWS)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder('utf-8')()
    frames = []
    durations = []
    last_bytes = None
    event = 0
    interval = 0.1
    timestamp = first_frame
    while timestamp <= duration:
        while event < len(EVENTS) and EVENTS[event][0] <= timestamp:
            stream.feed(decoder.decode(EVENTS[event][1]))
            event += 1
        if not frames:
            contents = '\n'.join(''.join(screen.buffer[row][column].data for column in range(COLUMNS)) for row in range(ROWS))
            assert all(label in contents for label in ['Telegram', 'Яндекс Почта', 'Настроить всё по шагам'])
        frame = Image.new('RGB', (width, height), '#080e18')
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle((8, 8, width - 9, height - 9), radius=12, fill=background, outline='#293b54')
        draw.rounded_rectangle((9, 9, width - 10, 36), radius=11, fill='#18263a')
        for x, fill in [(26, '#ff6c72'), (44, '#eac46d'), (62, '#68d4a3')]:
            draw.ellipse((x, 18, x + 8, 26), fill=fill)
        draw.text((90, 15), 'HSE HARNESS / CLI', font=font, fill='#bccce1')
        for row in range(ROWS):
            for column, char in screen.buffer[row].items():
                if column >= COLUMNS:
                    continue
                x, y = left + column * cell_width, top + row * cell_height
                fg, bg = color(char.fg, foreground), color(char.bg, background)
                if char.reverse:
                    fg, bg = bg, fg
                if bg != background:
                    draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), fill=bg)
                value = char.data
                if not value or value == ' ':
                    continue
                if value in ('▀', '▄', '█'):
                    start = y + cell_height // 2 if value == '▄' else y
                    stop = y + cell_height // 2 - 1 if value == '▀' else y + cell_height - 1
                    draw.rectangle((x, start, x + cell_width - 1, stop), fill=fg)
                elif emoji_font and (ord(value[0]) >= 0x1f000 or '\ufe0f' in value or value in ('✅', '❌')):
                    if value not in emoji_cache:
                        glyph = Image.new('RGBA', (40, 40))
                        ImageDraw.Draw(glyph).text((0, 0), value, font=emoji_font, embedded_color=True)
                        emoji_cache[value] = glyph.crop((0, 0, 32, 32)).resize((18, 18), Image.Resampling.LANCZOS)
                    frame.paste(emoji_cache[value], (x, y), emoji_cache[value])
                else:
                    draw.text((x, y), value, font=font, fill=fg, stroke_width=0)
                if char.underscore:
                    draw.line((x, y + cell_height - 2, x + max(1, wcswidth(value)) * cell_width - 1, y + cell_height - 2), fill=fg)
        if not screen.cursor.hidden:
            x, y = left + screen.cursor.x * cell_width, top + screen.cursor.y * cell_height
            draw.line((x, y + cell_height - 2, x + cell_width - 1, y + cell_height - 2), fill='#9dc9ff', width=2)
        raw = frame.tobytes()
        if raw == last_bytes:
            durations[-1] += 100
        else:
            frames.append(frame)
            durations.append(100)
            last_bytes = raw
        timestamp += interval
    # One shared palette keeps the blue logo and colored status icons stable.
    sample = Image.new('RGB', (width, height * 3))
    for index, source in enumerate([frames[min(3, len(frames) - 1)], frames[len(frames) // 2], frames[-2]]):
        sample.paste(source, (0, index * height))
    palette = sample.quantize(colors=256)
    quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(OUTPUT, save_all=True, append_images=quantized[1:], duration=durations, loop=0, optimize=True)
    print(f'{OUTPUT}: {len(frames)} frames, {sum(durations) / 1000:.1f}s, {OUTPUT.stat().st_size:,} bytes')


if __name__ == '__main__':
    render(*record())
