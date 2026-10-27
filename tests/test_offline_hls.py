"""常见 HLS 点播格式的真实封装回归；所有网络响应使用受控替身。"""

import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from tgdrive.offline.hls import _HlsRelay, parse_playlist, remux
from tgdrive.offline.http import DownloadError, ExpiredMedia, TransientError
from tgdrive.offline.mp4 import Defragmenter
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
    def __init__(self, bodies, ignore_range=False, close_delay=0):
        self.bodies, self.calls, self.ignore_range = bodies, [], ignore_range
        self.active, self.close_delay = 0, close_delay

    @asynccontextmanager
    async def open(self, request, *, url=None, extra_headers=None, url_check=None, **_):
        target = url or request.url
        if url_check:
            url_check(target)
        header = (extra_headers or {}).get('Range')
        self.calls.append((target, header))
        body = self.bodies[urlsplit(target).path.rsplit('/', 1)[-1]]
        if isinstance(body, Exception):
            raise body
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
        self.active += 1
        try:
            yield response
        finally:
            try:
                await asyncio.sleep(self.close_delay)
            finally:
                self.active -= 1


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
        for name, single, duration in (('fmp4', False, '3'), ('ranges', True, '3'), ('long', False, '30')):
            folder = cls.root / name
            folder.mkdir()
            args = ['-hls_flags', 'single_file'] if single else []
            command = common.copy()
            command[command.index('-t') + 1] = duration
            subprocess.run([*command, '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
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
        http = FixtureHttp(bodies, kwargs.pop('ignore_range', False), kwargs.pop('close_delay', 0))
        events = []
        async def throttle(_):
            pass
        stream = remux(http, request, playlist, FFMPEG, check=lambda: None,
            progress=lambda **values: events.append(values), throttle=throttle, **kwargs)
        # 全部复杂格式都必须避免暂存明文分片；验证过程也不允许转而缓存整个分片到文件。
        with patch.object(Path, 'open', side_effect=AssertionError('HLS 不应写入临时文件')):
            try:
                converter = Defragmenter()
                chunks = [chunk async for chunk in converter.payload(stream)]
                body = converter.header() + b''.join(chunks)
            finally:
                await stream.aclose()
        self.assertEqual(http.active, 0)
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

    async def test_ffmpeg_completion_waits_for_source_cleanup(self):
        folder = self.root / 'long'
        await self.collect((folder / 'index.m3u8').read_text(),
            {path.name: path.read_bytes() for path in folder.iterdir()}, close_delay=0.05)

    async def test_range_ignored_is_rejected(self):
        folder = self.root / 'ranges'
        text = (folder / 'index.m3u8').read_text()
        bodies = {path.name: path.read_bytes() for path in folder.iterdir()}
        with self.assertRaisesRegex(DownloadError, '字节范围'):
            await self.collect(text, bodies, ignore_range=True)

    async def test_output_starts_before_all_segments_arrive_and_cancel_closes_sources(self):
        folder = self.root / 'long'
        request = DownloadRequest('https://media.example/index.m3u8')
        playlist = parse_playlist((folder / 'index.m3u8').read_bytes(), request.url)
        http = FixtureHttp({path.name: path.read_bytes() for path in folder.iterdir()})
        async def throttle(_):
            pass
        stream = remux(http, request, playlist, FFMPEG, check=lambda: None,
            progress=lambda **_: None, throttle=throttle)
        try:
            async with asyncio.timeout(10):
                self.assertTrue(await anext(stream))
            self.assertLess(len(http.calls), len(playlist.items))
            await asyncio.sleep(0.05)
        finally:
            async with asyncio.timeout(5):
                await stream.aclose()
        self.assertEqual(http.active, 0)

    async def test_missing_segment_preserves_source_error_instead_of_saving_incomplete_video(self):
        for error in (TransientError('来源连接中断'), ExpiredMedia('平台地址过期')):
            with self.subTest(error=type(error)), self.assertRaisesRegex(type(error), str(error)):
                await self.collect('#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:3,\n1.ts\n'
                    '#EXTINF:3,\n2.ts\n#EXT-X-ENDLIST\n', {'1.ts': self.ts, '2.ts': error})


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_closing_relay_cancels_pending_source_request(self):
        entered, closed = asyncio.Event(), asyncio.Event()
        class BlockingHttp:
            @asynccontextmanager
            async def open(self, *_, **__):
                try:
                    entered.set()
                    await asyncio.Event().wait()
                    yield
                finally:
                    closed.set()
        async def throttle(_):
            pass
        request = DownloadRequest('https://media.example/index.m3u8')
        playlist = parse_playlist(b'#EXTM3U\n#EXTINF:3,\n1.ts\n#EXT-X-ENDLIST\n', request.url)
        async with asyncio.timeout(5):
            async with _HlsRelay(BlockingHttp(), check=lambda: None, progress=lambda **_: None,
                                 throttle=throttle, url_check=None, phase=None) as relay:
                relay.playlist(request, playlist, 'video.m3u8')
                reader, writer = await asyncio.open_connection('127.0.0.1', relay.server.sockets[0].getsockname()[1])
                writer.write(f'GET {next(iter(relay.routes))} HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
                await writer.drain()
                await entered.wait()
            self.assertTrue(closed.is_set())
            self.assertEqual(await reader.read(), b'')
            writer.close()
            await writer.wait_closed()

    async def test_only_registered_get_routes_are_accessible_and_playlist_hides_source(self):
        http = FixtureHttp({'1.ts': b'video'})
        request = DownloadRequest('https://media.example/index.m3u8?signature=hidden',
                                  headers=[('Cookie', 'secret=hidden')])
        playlist = parse_playlist(b'#EXTM3U\n#EXTINF:3,\n1.ts\n#EXT-X-ENDLIST\n', request.url)
        async def throttle(_):
            pass
        async with _HlsRelay(http, check=lambda: None, progress=lambda **_: None,
                             throttle=throttle, url_check=None, phase=None) as relay:
            url = relay.playlist(request, playlist, 'video.m3u8')
            path = urlsplit(url).path
            for method, target, status in (('GET', path, 200), ('POST', path, 404),
                                           ('GET', '/video.m3u8', 404), ('GET', relay.prefix + '../file', 404)):
                reader, writer = await asyncio.open_connection('127.0.0.1', relay.server.sockets[0].getsockname()[1])
                writer.write(f'{method} {target} HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
                await writer.drain()
                body = await reader.read()
                writer.close()
                await writer.wait_closed()
                self.assertTrue(body.startswith(f'HTTP/1.1 {status} '.encode()))
                self.assertNotIn(b'https://', body)
                self.assertNotIn(b'hidden', body)
            self.assertEqual(http.calls, [])


if __name__ == '__main__':
    unittest.main()
