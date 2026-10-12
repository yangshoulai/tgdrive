"""常见 HLS 点播格式的真实封装回归；所有网络响应使用受控替身。"""

import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from tgdrive.offline.hls import parse_playlist, remux
from tgdrive.offline.http import DownloadError
from tgdrive.offline.request import DownloadRequest


class PlaylistTests(unittest.TestCase):
    def parse(self, text):
        return parse_playlist(text.encode(), "https://media.example/video/index.m3u8")

    def test_map_ranges_keys_and_discontinuities(self):
        parsed = self.parse('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:50\n'
            '#EXT-X-MAP:URI="all.mp4",BYTERANGE="100@0"\n'
            '#EXTINF:2,\n#EXT-X-BYTERANGE:200@100\nall.mp4\n'
            '#EXT-X-DISCONTINUITY\n#EXTINF:3,\n#EXT-X-BYTERANGE:300\nall.mp4\n#EXT-X-ENDLIST\n')
        self.assertEqual(parsed.sequence, 50)
        self.assertEqual(parsed.items[0].init.byte_range, (0, 100))
        self.assertEqual(parsed.items[1].asset.byte_range, (300, 300))
        self.assertTrue(parsed.items[1].discontinuity)
        self.assertEqual(parsed.duration, 5)

    def test_aes_key_rotation_and_none(self):
        parsed = self.parse('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n'
            '#EXTINF:2,\n1.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x02\n'
            '#EXTINF:2,\n2.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\n3.ts\n#EXT-X-ENDLIST\n')
        self.assertEqual(parsed.items[0].asset.key.url, 'https://media.example/video/key')
        self.assertEqual(parsed.items[1].asset.key.iv, '0x' + '0' * 31 + '2')
        self.assertIsNone(parsed.items[2].asset.key)

    def test_master_separate_audio_and_subtitle(self):
        parsed = self.parse('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio.m3u8"\n'
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\nvideo.m3u8\n')
        self.assertEqual(parsed.audio[parsed.variants[0][0]], 'https://media.example/video/audio.m3u8')

    def test_malformed_and_drm_are_rejected(self):
        for tag in ('#EXT-X-BYTERANGE:0@0', '#EXT-X-BYTERANGE:1', '#EXT-X-BYTERANGE:5@-1',
                    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"',
                    '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=xyz',
                    '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMAT="com.apple.streamingkeydelivery"',
                    '#EXT-X-PART:DURATION=0.2,URI="part.ts"', '#EXT-X-GAP',
                    '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"'):
            with self.subTest(tag=tag), self.assertRaises(DownloadError):
                self.parse(f'#EXTM3U\n{tag}\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n')
        with self.assertRaises(DownloadError):
            self.parse('#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:5@0\na.ts\n'
                       '#EXTINF:2,\n#EXT-X-BYTERANGE:5\nb.ts\n#EXT-X-ENDLIST\n')


class FixtureHttp:
    def __init__(self, bodies, ignore_range=False):
        self.bodies, self.calls, self.ignore_range = bodies, [], ignore_range

    @asynccontextmanager
    async def open(self, request, *, url=None, extra_headers=None, url_check=None, **_):
        target = url or request.url
        if url_check:
            url_check(target)
        header = (extra_headers or {}).get('Range')
        self.calls.append((target, header))
        body = self.bodies[urlsplit(target).path.rsplit('/', 1)[-1]]
        status, headers = 200, {}
        if header and not self.ignore_range:
            start, end = map(int, header.removeprefix('bytes=').split('-'))
            headers['content-range'] = f'bytes {start}-{end}/{len(body)}'
            body, status = body[start:end + 1], 206
        class Response:
            async def stream(inner):
                for offset in range(0, len(body), 65536):
                    yield body[offset:offset + 65536]
        response = Response()
        response.status, response.headers, response.size = status, headers, len(body)
        yield response


FFMPEG = os.environ.get('TGDRIVE_TEST_FFMPEG') or shutil.which('ffmpeg')


@unittest.skipUnless(FFMPEG, '需要 FFmpeg 验证真实 HLS 封装')
class RemuxTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        common = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                  'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
                  '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-sc_threshold', '0', '-c:a', 'aac']
        subprocess.run([*common, '-f', 'mpegts', str(cls.root / 'source.ts')], check=True, capture_output=True)
        for name, single in (('fmp4', False), ('ranges', True)):
            folder = cls.root / name
            folder.mkdir()
            args = ['-hls_flags', 'single_file'] if single else []
            subprocess.run([*common, '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
                '-hls_segment_type', 'fmp4', *args, 'index.m3u8'], cwd=folder, check=True, capture_output=True)
        cls.ts = (cls.root / 'source.ts').read_bytes()
        folder = cls.root / 'audio'
        folder.mkdir()
        subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
            'sine=frequency=1000:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-f', 'hls',
            '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', 'audio-init.mp4', 'audio.m3u8'], cwd=folder, check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    async def collect(self, text, bodies, **kwargs):
        request = DownloadRequest('https://media.example/index.m3u8', headers=[('Cookie', 'secret=hidden')])
        playlist = parse_playlist(text.encode(), request.url)
        http = FixtureHttp(bodies, kwargs.pop('ignore_range', False))
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / 'cache'
            events = []
            async def throttle(_):
                pass
            stream = remux(http, request, playlist, FFMPEG, cache_root=cache, task_id=1,
                limit=8 * 1024 * 1024, reserve=0, check=lambda: None,
                progress=lambda **values: events.append(values), throttle=throttle, **kwargs)
            try:
                chunks = []
                async for chunk in stream:
                    chunks.append(chunk)
                    for path in cache.glob('task-*/*.m3u8'):
                        self.assertNotIn('https://', path.read_text())
                        self.assertNotIn('secret', path.read_text())
                body = b''.join(chunks)
            finally:
                await stream.aclose()
            self.assertEqual(list(cache.glob('task-*')), [])
        output = self.root / 'output.mp4'
        output.write_bytes(body)
        mapping = ['-map', '0:a:0'] if kwargs.get('media_type') == 'audio' else ['-map', '0:v:0', '-map', '0:a:0']
        decoded = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', str(output), *mapping,
            '-f', 'null', '-'], capture_output=True)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors='replace'))
        self.assertFalse(decoded.stderr, decoded.stderr.decode(errors='replace'))
        self.assertGreater(len(body), 1000)
        return http, events

    async def test_discontinuities_remux_real_ts(self):
        _, events = await self.collect('#EXTM3U\n#EXTINF:3,\n1.ts\n#EXT-X-DISCONTINUITY\n'
            '#EXTINF:3,\n2.ts\n#EXT-X-ENDLIST\n', {'1.ts': self.ts, '2.ts': self.ts})
        self.assertEqual([event['segment'] for event in events if 'segment' in event], [1, 2])

    async def test_fmp4_init_and_single_file_ranges(self):
        for name in ('fmp4', 'ranges'):
            with self.subTest(name=name):
                folder = self.root / name
                http, _ = await self.collect((folder / 'index.m3u8').read_text(),
                                            {path.name: path.read_bytes() for path in folder.iterdir()})
                if name == 'ranges':
                    self.assertTrue(all(span for _, span in http.calls))

    async def test_aes_rotation_uses_media_sequence_and_iv(self):
        def encrypt(key, iv):
            padder = padding.PKCS7(128).padder()
            padded = padder.update(self.ts) + padder.finalize()
            cipher = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
            return cipher.update(padded) + cipher.finalize()
        key1, key2 = b'1' * 16, b'2' * 16
        bodies = {'key1': key1, 'key2': key2, '1.ts': encrypt(key1, (50).to_bytes(16, 'big')),
                  '2.ts': encrypt(key2, (2).to_bytes(16, 'big')), '3.ts': self.ts}
        http, _ = await self.collect('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:50\n'
            '#EXT-X-KEY:METHOD=AES-128,URI="key1"\n#EXTINF:3,\n1.ts\n'
            '#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x02\n'
            '#EXTINF:3,\n2.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n'
            '#EXTINF:3,\n3.ts\n#EXT-X-ENDLIST\n', bodies)
        self.assertEqual(sum(target.endswith('/key1') for target, _ in http.calls), 1)

    async def test_separate_audio_playlist(self):
        video, sound = self.root / 'fmp4', self.root / 'audio'
        audio_request = DownloadRequest('https://media.example/audio.m3u8')
        audio = parse_playlist((sound / 'audio.m3u8').read_bytes(), audio_request.url)
        bodies = {path.name: path.read_bytes() for folder in (video, sound) for path in folder.iterdir()}
        _, events = await self.collect((video / 'index.m3u8').read_text(), bodies, audio=(audio_request, audio))
        self.assertEqual(sum(event.get('seconds', 0) for event in events), 3)

    async def test_audio_only_hls_remuxes_to_m4a(self):
        folder = self.root / 'audio'
        await self.collect((folder / 'audio.m3u8').read_text(),
            {path.name: path.read_bytes() for path in folder.iterdir()}, media_type='audio')

    async def test_range_ignored_and_cache_limit_clean_up(self):
        folder = self.root / 'ranges'
        text = (folder / 'index.m3u8').read_text()
        bodies = {path.name: path.read_bytes() for path in folder.iterdir()}
        with self.assertRaisesRegex(DownloadError, '字节范围'):
            await self.collect(text, bodies, ignore_range=True)
        with tempfile.TemporaryDirectory() as directory:
            async def throttle(_):
                pass
            stream = remux(FixtureHttp({'1.ts': self.ts}), DownloadRequest('https://media.example/index.m3u8'),
                parse_playlist(b'#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:3,\n1.ts\n#EXT-X-ENDLIST\n', 'https://media.example/index.m3u8'),
                FFMPEG, cache_root=Path(directory), limit=100, check=lambda: None, progress=lambda **_: None, throttle=throttle)
            with self.assertRaisesRegex(DownloadError, '缓存大小上限'):
                await anext(stream)
            await stream.aclose()
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
