"""压缩文本还原的自测（不连接微信、不启动桥接）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from compression import zstd  # noqa: E402
from wechat_bridge import decode_wx_text  # noqa: E402


def test_plain_utf8():
    assert decode_wx_text("你好".encode("utf-8")) == "你好"


def test_zstd_frame():
    text = "wxid_biswps9aw3hc22:\n@海阔天空\u2005回我消息"
    frame = zstd.compress(text.encode("utf-8"))
    assert decode_wx_text(frame) == text


def test_empty():
    assert decode_wx_text(b"") == ""
    assert decode_wx_text(None) == ""


if __name__ == "__main__":
    test_plain_utf8()
    test_zstd_frame()
    test_empty()
    print("decode text tests: 3 passed")
