#!/usr/bin/env python3
"""Build a standalone static site; _news Markdown is collected automatically."""
import argparse
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from news_content import collect_news


def build(output):
    data = collect_news(ROOT)
    if data['errors']:
        raise ValueError('\n'.join(data['errors']))
    output.mkdir(parents=True, exist_ok=True)
    for name in ['index.html', 'app.js', 'telemetry.js', 'provisioning.js', 'platform_features.js', 'organization.js', 'portal.js', 'visual.js', 'news.js', 'styles.css',
                 'users.json', 'devices.json', 'platform.json', 'favicon.svg', 'favicon.ico', 'favicon.png']:
        shutil.copy2(ROOT / name, output / name)
    index = output / 'index.html'
    index.write_text(index.read_text().replace('name="platform-mode" content="backend"', 'name="platform-mode" content="demo"'), encoding='utf-8')
    for name in ['content', 'assets']:
        if (ROOT / name).exists():
            shutil.copytree(ROOT / name, output / name, dirs_exist_ok=True)
    (output / '.nojekyll').touch()
    (output / 'news-index.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'已生成 {len(data["articles"])} 篇文章：{output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    build(args.output)
