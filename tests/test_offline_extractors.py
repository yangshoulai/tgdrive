"""上游错误分类与 YouTube 格式筛选，避免 Cookie 改变客户端后丢失 HLS。"""

import unittest
from unittest.mock import patch

from tgdrive.offline.extract_worker import extraction_failure, youtube, youtube_entries
from tgdrive.offline.platforms import capabilities


class ExtractorTests(unittest.TestCase):
    def test_errors_are_classified_without_exposing_details(self):
        for message, expected in (("'Unavailable'", "unavailable"), ("NSFW Tweet", "login"),
            ("Protected Tweet", "login"), ("Could not authenticate you", "cookie"),
            ("429 Too Many Requests", "rate_limit"), ("403 Forbidden", "forbidden"),
            ("Sign in to confirm you're not a bot", "bot"),
            ("Signature extraction failed", "js")):
            with self.subTest(message=message):
                error = ValueError(message + ' secret=private https://signed.example/?token=private')
                result = extraction_failure(error)
                self.assertEqual(result['error'], expected)
                self.assertNotIn('private', str(result))
                self.assertNotIn('signed.example', str(result))
        auth = type('AuthRequired', (Exception,), {})('account credentials required')
        self.assertEqual(extraction_failure(auth)['error'], 'login')
        outer = RuntimeError('wrapped extraction failure')
        outer.__cause__ = ValueError('Invalid or expired token')
        self.assertEqual(extraction_failure(outer)['error'], 'cookie')

    def test_hls_formats_survive_and_can_replace_forbidden_direct_format(self):
        info = {'id': 'BaW_jenozKc', 'title': 'Test', 'duration': 3, 'formats': [
            {'protocol': 'https', 'url': 'https://r1.googlevideo.com/video', 'ext': 'mp4',
             'vcodec': 'avc1.4d001e', 'acodec': 'none', 'height': 720, 'filesize': 1000},
            {'protocol': 'https', 'url': 'https://r1.googlevideo.com/audio', 'ext': 'm4a',
             'vcodec': 'none', 'acodec': 'mp4a.40.2', 'abr': 128, 'filesize': 200},
            {'protocol': 'm3u8_native', 'url': 'https://manifest.googlevideo.com/720.m3u8', 'ext': 'mp4',
             'vcodec': 'avc1.4d001e', 'acodec': 'mp4a.40.2', 'height': 720},
            {'protocol': 'm3u8_native', 'url': 'https://manifest.googlevideo.com/360.m3u8', 'ext': 'mp4',
             'vcodec': 'avc1.4d001e', 'acodec': 'mp4a.40.2', 'height': 360},
            {'protocol': 'm3u8_native', 'url': 'https://manifest.googlevideo.com/1080.m3u8', 'ext': 'mp4',
             'vcodec': 'avc1.4d001e', 'acodec': 'mp4a.40.2', 'height': 1080},
        ]}
        ordinary = youtube_entries(info, {'max_height': 720})['entries']
        fallback = youtube_entries(info, {'max_height': 720, 'prefer_hls': True})['entries']
        self.assertEqual([entry['variant'] for entry in ordinary], ['720p · MP4', '360p · MP4', '仅音频 · M4A'])
        self.assertEqual([len(entry['tracks']) for entry in ordinary], [2, 1, 1])
        self.assertEqual(ordinary[0]['tracks'][0]['protocol'], 'https')
        self.assertEqual(fallback[0]['tracks'][0]['protocol'], 'hls')
        self.assertEqual(ordinary[0]['selection'], fallback[0]['selection'])
        hls_only = youtube_entries({**info, 'formats': info['formats'][2:]}, {'max_height': 720})['entries']
        self.assertEqual([entry['variant'] for entry in hls_only], ['720p · MP4', '360p · MP4'])
        self.assertTrue(all(len(entry['tracks']) == 1 for entry in hls_only))
        info['formats'].append({'protocol': 'm3u8_native', 'url': 'https://manifest.googlevideo.com/audio.m3u8',
            'ext': 'mp4', 'vcodec': 'none', 'acodec': 'mp4a.40.2', 'abr': 96})
        audio_fallback = youtube_entries(info, {'max_height': 720, 'prefer_hls': True})['entries'][-1]
        self.assertEqual(audio_fallback['selection'], ordinary[-1]['selection'])
        self.assertEqual(audio_fallback['tracks'][0]['protocol'], 'hls')

    @unittest.skipUnless(capabilities()['youtube_available'], '未安装可选 YouTube 解析组件')
    def test_listing_formats_does_not_test_download_media(self):
        from yt_dlp.extractor.youtube import YoutubeIE
        info = {'id': 'BaW_jenozKc', 'title': 'Test', 'duration': 3, 'formats': [
            {'format_id': '18', 'protocol': 'https', 'url': 'https://r1.googlevideo.com/video?token=private',
             'ext': 'mp4', 'vcodec': 'avc1.4d001e', 'acodec': 'mp4a.40.2', 'height': 360,
             '__needs_testing': True}]}
        payload = {'url': 'https://www.youtube.com/watch?v=BaW_jenozKc', 'cookies': [],
                   'runtime': capabilities()['runtime'], 'max_height': 720, 'user_agent': 'Test'}
        with patch.object(YoutubeIE, '_real_extract', return_value=info), \
                patch('tgdrive.offline.extract_worker.fetch', side_effect=AssertionError('media must not be requested')) as fetch:
            result = youtube(payload)
        self.assertEqual(result['entries'][0]['variant'], '360p · MP4')
        fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
