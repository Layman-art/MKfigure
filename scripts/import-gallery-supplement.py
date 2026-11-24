"""Verify figure identities, academic source locations and the images available on this machine."""
import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / 'resources' / 'paper-gallery'
FORMS = {'curve', 'bar', 'scatter', 'distribution', 'heatmap', 'field', 'qualitative',
         'surface', 'pointcloud', 'volume', 'mesh'}
PATTERNS = {'teaser', 'conceptual', 'framework', 'pipeline', 'architecture', 'taxonomy', 'results', 'comparison'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def normalized_title(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', value).casefold() if c.isalnum())


def paper_key(url):
    part = urlsplit(url)
    if part.hostname in {'icml.cc', 'neurips.cc'}:
        poster = re.fullmatch(r'/virtual/(\d+)/(?:loc/[^/]+/)?poster/(\d+)/?', part.path)
        if poster:
            return f'{part.hostname}/{poster[1]}/poster/{poster[2]}'
    if part.hostname in {'arxiv.org', 'www.arxiv.org'}:
        return 'arxiv/' + re.sub(r'v\d+$', '', part.path.removesuffix('.pdf').split('/')[-1])
    return urlunsplit(('', part.netloc.lower().removeprefix('www.'), part.path.rstrip('/'), part.query, ''))


def source_page(row, pdf):
    import fitz
    details = row['supplement']
    require(hashlib.sha256(pdf.read_bytes()).hexdigest() == details['pdfSha256'], f'PDF hash differs: {pdf}')
    with fitz.open(pdf) as document:
        page = document[row['page'] - 1]
        crop = fitz.Rect(details['cropPdfPoints'])
        require(not crop.is_empty and page.rect.contains(crop), 'Crop lies outside the cited page')
        number = row['figure'].split()[-1]
        require(re.search(r'(?i)\bfig(?:ure)?\.?\s*' + number + r'\b', page.get_text()), 'Figure number missing on page')


def verify(gallery, wanted_id, pdf, require_images=False):
    base = json.loads((gallery/'data'/'figures.json').read_text(encoding='utf-8'))
    rows = json.loads((gallery/'supplement'/'figures.json').read_text(encoding='utf-8'))
    old_titles = {normalized_title(r['title']) for r in base}
    old_urls = {paper_key(r[k]) for r in base for k in ('paper', 'pdf_source') if r.get(k)}
    paths, hashes, by_paper, by_title, by_pdf = set(), set(), {}, {}, {}
    checked_images = 0
    for r in rows:
        ident, details = r['id'], r['supplement']
        cat = details['category']
        number = re.fullmatch(r'Figure ([1-9]\d*)', r['figure'])
        require(number and cat in {'main', 'result', 'mechanism', 'algorithm'} and (number[1] == '1') == (cat == 'main'), ident)
        require(r['authors'] and all(isinstance(x, str) and x.strip() for x in r['authors']), ident)
        require(r['pattern'] in PATTERNS and details['description'].strip(), ident)
        locators = [r['paper'], details['sourceUrl']]
        if r.get('page'):
            require(r['page'] >= 1 and details['pdfVersion'] in {'proceedings','author-public'}, ident)
            require(re.fullmatch(r'[0-9a-f]{64}', details['pdfSha256']) and len(details['cropPdfPoints']) == 4, ident)
            locators.append(r['pdf_source'])
        else:
            require(r.get('figureUrl') and urlsplit(r['figureUrl']).fragment and details.get('imageSource'), ident)
            locators.extend((r['figureUrl'], details['imageSource']))
        for url in locators:
            require(urlsplit(url).scheme == 'https' and urlsplit(url).hostname, ident)
        title, key = normalized_title(r['title']), paper_key(r['paper'])
        pdf_key = paper_key(r['pdf_source']) if r.get('pdf_source') else None
        if cat == 'main':
            require(title not in old_titles and not ({key,pdf_key} & old_urls), f'Duplicate upstream main: {ident}')
        require(by_title.setdefault(title,key) == key and by_paper.setdefault(key,title) == title
                and (not pdf_key or by_pdf.setdefault(pdf_key,title) == title), f'Conflicting paper metadata: {ident}')
        suffix = hashlib.sha256(key.encode()).hexdigest()[:14]
        require(ident == f'mk-{r["venue"]}{r["year"]}-{suffix}-f{number[1]}' and ident.isascii(), ident)
        require(r['image'] == f'supplement/images/{ident}.jpg', ident)
        if cat == 'result':
            require(details.get('dimensions') and set(details['dimensions']) <= {'2d','3d'}
                    and details.get('forms') and set(details['forms']) <= FORMS, ident)
        else:
            require('dimensions' not in details and 'forms' not in details, ident)
        img = gallery/r['image']
        digest = details['sha256']
        require(re.fullmatch(r'[0-9a-f]{64}',digest) and img not in paths and digest not in hashes, f'Duplicate or invalid digest: {ident}')
        if require_images or img.is_file():
            require(hashlib.sha256(img.read_bytes()).hexdigest() == digest, f'Digest differs: {ident}')
            with Image.open(img) as im:
                require(im.format == 'JPEG' and im.size == (r['w'], r['h']), f'Format or dimensions differ: {ident}')
                im.load()
            checked_images += 1
        paths.add(img)
        hashes.add(digest)
    require(not set((gallery/'supplement'/'images').glob('*.jpg')) - paths, 'Unindexed gallery JPEG')
    if pdf:
        selected = next((r for r in rows if r['id'] == wanted_id), None)
        require(selected and selected.get('page'), f'No PDF page for {wanted_id}')
        source_page(selected, pdf)
    print(f'{len(rows)} figures, {len(by_paper)} papers, {checked_images} verified JPEGs: {dict(Counter(r["supplement"]["category"] for r in rows))}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gallery', type=Path, default=ROOT)
    parser.add_argument('--id', help='Figure ID for an optional PDF check')
    parser.add_argument('--require-images', action='store_true', help='Require all numbered figure JPEGs in the local source cache')
    parser.add_argument('--source-pdf', type=Path, help='Original PDF version named by pdf_source')
    args = parser.parse_args()
    if bool(args.id) != bool(args.source_pdf):
        parser.error('--id and --source-pdf must be used together')
    verify(args.gallery, args.id, args.source_pdf, args.require_images)
