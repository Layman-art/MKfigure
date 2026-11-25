"""Build the public index, attributed open-image pack, and optional personal offline cache.

Pass the figure-level, visually reviewed JSON manifests. Their relative image paths are resolved
in each manifest's directory. The source files are read only. Source PDF files are never bundled.
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import threading
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

import cv2
import numpy as np
from PIL import Image
from build_layout_index import write_index
try:
    from mozjpeg_lossless_optimization import optimize as optimize_jpeg
except ImportError:
    optimize_jpeg = None

ROOT = Path(__file__).resolve().parents[1]
JOURNAL_VENUES = frozenset(json.loads((ROOT / 'src/shared/journal-venues.json').read_text(encoding='utf8')))
CARD_PREVIEW_PROFILE = 2
ENCODING_LOCKS = [threading.Lock() for _ in range(64)]
OPEN = re.compile(r'^https?://creativecommons\.org/(?:licenses/by/(?:[1-4]\.0|2\.5)|publicdomain/zero/1\.0)/?$', re.I)
CREDIT = re.compile(r'reprinted|reproduced (?:with|from|by)|adapted (?:with permission|from)|courtesy of|©|third.party material|all rights reserved|used (?:by|with|under) (?:license|licence|permission)|(?:photograph|image|illustration|map|basemap|photo) (?:credit|by\b)|credited to|(?:map tiles|basemap) from', re.I)
PAPER_TOPICS = {
    'powerflow': r'power.flow|optimal power flow|load flow',
    'stability': r'transient stability|small.signal stability|stability region|region of attraction|lyapunov',
    'frequency': r'frequency (?:control|regulation|response|nadir)|grid.forming|frequency stability',
    'voltage': r'voltage (?:control|regulation|stability|profile)',
    'dispatch': r'economic dispatch|unit commitment|dispatch|scheduling',
    'market': r'electricity market|locational marginal pric|energy market|electricity pric|tariff',
    'renewables': r'photovoltaic|wind farm|wind turbine|renewable generation|solar power|wind power',
    'storage': r'batter(?:y|ies)|energy storage|supercapacitor',
    'forecast': r'forecast|time.series prediction|trajectory prediction',
    'resilience': r'power system restoration|black.?start|grid resilience|outage|system reliability',
    'emissions': r'decarboni[sz]|carbon emissions?|carbon intensity|greenhouse gas',
    'charging': r'charging station|electric vehicle|vehicle.to.grid',
    'control': r'predictive control|distributed control|feedback control|inverter|power converter',
    'graphlearning': r'graph neural|graph representation learning',
    'dynamics': r'power.system dynamics|dynamic (?:simulation|equivalent|model)|time.domain simulation|electromagnetic transient|differential.algebraic|small.signal model|transient response',
    'neuraldynamics': r'neural (?:ordinary|differential|operator|ODE)|physics.informed|Koopman operator|learning dynamical systems|learned dynamical model',
    'gridtransfer': r'network reconfiguration|topology (?:change|transfer|variation|generalization)|across (?:different )?(?:grid |network )?topolog|cross.scenario|unseen (?:operating|grid|topolog)|across (?:operating|loading) (?:points|conditions)',
    'identification': r'system identification|parameter identification|dynamic state estimation|closed.loop identification|subspace identification',
}


def json_file(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(file, data):
    file.parent.mkdir(exist_ok=True, parents=True)
    data = json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    tmp = file.with_name(file.name + '.part')
    tmp.write_text(data + '\n', encoding='utf8')
    tmp.replace(file)


def link_or_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if os.path.samefile(source, target) or (source.stat().st_size == target.stat().st_size and sha(source.read_bytes()) == sha(target.read_bytes())):
            return
    tmp = target.with_name(target.name + '.part')
    tmp.unlink(missing_ok=True)
    try:
        os.link(source, tmp)
    except OSError:
        shutil.copyfile(source, tmp)
    tmp.replace(target)


@lru_cache(maxsize=5000)
def file_hash(file):
    return sha(file.read_bytes())


def encode(path, cache):
    raw = path.read_bytes()
    digest = sha(raw)
    with ENCODING_LOCKS[int(digest[:2], 16) % len(ENCODING_LOCKS)]:
        return encode_pixels(raw, digest, cache)


def encode_pixels(raw, digest, cache):
    folder = cache / digest[:2]
    folder.mkdir(exist_ok=True, parents=True)
    facts = folder / (digest + '.json')
    previous = None
    profile = 2 if optimize_jpeg else 1
    if facts.exists():
        old = json_file(facts)
        if (folder / old['file']).is_file() and (folder / (digest + '-preview.webp')).is_file():
            if old.get('codecProfile',1) >= profile and old.get('cardPreviewProfile') == CARD_PREVIEW_PROFILE:
                return old, folder
            previous = old
    with Image.open(io.BytesIO(raw)) as opened:
        opened.load()
        img = opened.convert('RGB')
    w, h = img.size
    if min(w, h) < 45 or max(w, h) < 280:
        raise ValueError(f'insufficient source resolution {w} x {h}')
    thumb = img.copy()
    thumb.thumbnail((800, 1800), Image.Resampling.LANCZOS)
    preview_path = folder / (digest + '-preview.webp')
    preview_tmp = preview_path.with_suffix('.webp.part')
    thumb.save(preview_tmp, 'WEBP', quality=87, method=4)
    preview_tmp.replace(preview_path)
    if previous and previous.get('codecProfile',1) >= profile:
        previous['cardPreviewProfile'] = CARD_PREVIEW_PROFILE
        compact(facts, previous)
        return previous, folder
    pixels = np.asarray(img)
    gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    plane = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    coef = cv2.dct(plane.astype(np.float32))[:8, :8]
    phash = np.packbits(coef > np.median(coef.ravel()[1:])).tobytes().hex()
    if previous:
        candidate = (folder/previous['file']).read_bytes() if previous['file'].endswith('.webp') else raw
    else:
        webp = io.BytesIO()
        img.save(webp, 'WEBP', lossless=True, method=3)
        candidate = webp.getvalue()
    extension, full = 'jpg', raw
    if opened.format != 'JPEG' or len(candidate) < len(raw):
        with Image.open(io.BytesIO(candidate)) as check:
            if not np.array_equal(pixels, np.asarray(check.convert('RGB'))):
                raise ValueError('lossless verification failed')
        extension, full = 'webp', candidate
    optimized = False
    if optimize_jpeg and opened.format == 'JPEG':
        lossless_jpg = optimize_jpeg(raw)
        if len(lossless_jpg) < len(full):
            with Image.open(io.BytesIO(lossless_jpg)) as check:
                if np.array_equal(pixels, np.asarray(check.convert('RGB'))):
                    full, extension, optimized = lossless_jpg, 'jpg', True
    fname = digest + ('.opt.' if optimized else '.') + extension
    (folder / fname).write_bytes(full)
    record = dict(originalSha=digest, hash=sha(full), file=fname, phash=phash, w=w, h=h, codecProfile=profile, cardPreviewProfile=CARD_PREVIEW_PROFILE, optimizedJpeg=optimized,
                  originalBytes=len(raw), bytes=len(full))
    compact(facts, record)
    return record, folder


def url(value):
    if not isinstance(value, str) or not value:
        return ''
    parsed = urlparse(value)
    return value if parsed.scheme in ('http', 'https') and parsed.hostname and not (parsed.username or parsed.password) else ''


def key(row):
    fig = re.fullmatch(r'(?:Fig(?:ure)?\.?\s*)?(\d+)', str(row.get('figure', '')), re.I)
    doi = str(row.get('doi', '')).lower().strip()
    if not fig or not re.fullmatch(r'10\.\d{4,9}/\S+', doi):
        raise ValueError('invalid DOI or numbered figure')
    return doi, int(fig[1])


@lru_cache(maxsize=1200)
def jats_figure_credits(xml_file):
    article = ElementTree.parse(xml_file).getroot()
    meta = article.find('./front/article-meta')
    if meta is None:
        return {}
    article_lic = meta.find('./permissions/license')
    if article_lic is None:
        return {}
    rights = ' '.join(article_lic.attrib.values())+' '+''.join(article_lic.itertext())
    result = {}
    for figure in article.findall('.//fig'):
        number = figure.findtext('label','')
        graphics = [str(g.get('{http://www.w3.org/1999/xlink}href','')).rsplit('/',1)[-1] for g in figure.findall('.//graphic')]
        local_credit = figure.find('attrib') is not None or figure.find('permissions') is not None
        words = ' '.join(''.join(figure.itertext()).split())
        if number and not local_credit and not CREDIT.search(words):
            result[figure.get('id')] = (rights,graphics)
    return result


def open_license(row, lic, base):
    if not isinstance(lic, str) or not OPEN.fullmatch(lic) or CREDIT.search(str(row.get('caption', ''))):
        return False
    evidence = row.get('licenseEvidence') or {}
    if row.get('sourceKind') == 'publisher-html-open':
        article = 'https://www.nature.com/articles/'+row['doi'].split('/',1)[-1]
        source = urlparse(row.get('imageSource',''))
        number = key(row)[1]
        media = unquote(source.path)
        return (evidence.get('scope') == 'same-version-article' and evidence.get('url') == article+'#rightslink' and
                row.get('figureUrl') == article+'#Fig'+str(number) and source.hostname == 'media.springernature.com' and
                media.startswith('/full/springer-static/image/art:'+row['doi']+'/MediaObjects/') and
                re.search(rf'_Fig{number}_HTML\.[a-z]+$', media, re.I) is not None)
    source_image = str(row.get('imageSource') or row.get('figureUrl') or '')
    if row.get('sourceKind') == 'publisher-jats-matched':
        native = urlparse(source_image)
        archival = urlparse(row['rightsImageSource'])
        article = 'https://www.nature.com/articles/'+row['doi'].split('/', 1)[-1]
        figure = 'Fig'+str(key(row)[1])
        if (native.hostname != 'media.springernature.com' or archival.hostname != 'pmc-oa-opendata.s3.amazonaws.com'
                or not unquote(native.path).startswith('/full/springer-static/image/art:'+row['doi']+'/MediaObjects/')
                or row.get('figureUrl') != article+'#'+figure or evidence.get('scope') != 'publisher-version-jats'
                or evidence.get('url') != 'https://pmc.ncbi.nlm.nih.gov/articles/'+row.get('pmcid','')+'/#'+figure
                or Path(native.path).stem != Path(archival.path).stem):
            return False
        source_image = row['rightsImageSource']
    source_match = re.search(r'/((PMC\d+)\.\d+)/([^/?#]+)$', source_image)
    if not source_match:
        return False
    loc = str(row.get('figureAnchor') or row.get('figureUrl') or '').split('#')[-1]
    xml = base/'xml'/(source_match[2]+'.xml')
    if not xml.is_file():
        xml = base.parent/'nature'/'xml'/(source_match[2]+'.xml')
    if not xml.is_file():
        return False
    item = jats_figure_credits(xml).get(loc)
    return bool(item and lic.split('creativecommons.org/')[-1].strip('/') in item[0] and source_match[3] in item[1])


def one(job):
    src, row, forms, args = job
    if row.get('journal') not in JOURNAL_VENUES:
        raise ValueError('journal outside the supported catalog')
    doi, num = key(row)
    if num < 1:
        raise ValueError('figure requires a positive original number')
    year = int(row['year'])
    category = row['category']
    if not 2017 <= year <= 2026 or category not in ('result', 'mechanism', 'algorithm') or not row.get('authors'):
        raise ValueError('outside period or missing classification or authors')
    relative = Path(row['image'])
    base = src.parent.resolve()
    original = (base / relative).resolve()
    if not original.is_relative_to(base):
        raise ValueError('image outside the source directory')
    enc, folder = encode(original, args.encoding_cache)
    if row.get('sha256') and row['sha256'] != enc['originalSha']:
        raise ValueError('reviewed image checksum mismatch')
    ident = f"mk-j-{row['journal']}-{sha(doi.encode())[:14]}-f{num}"
    license_text = row.get('license') or row.get('arxivLicense') or row.get('repositoryLicense') or ''
    lic = url(license_text) if isinstance(license_text, str) else ''
    pdf = url(row.get('pdfUrl'))
    page = row.get('page')
    page = page if type(page) is int and page > 0 else None
    html = url(row.get('htmlUrl'))
    locator = str(row.get('figureAnchor') or row.get('pageAnchor') or '')
    anchor = locator.split('#')[-1] if '#' in locator else locator
    original_link = url(row.get('figureUrl'))
    figurl = html.split('#')[0]+'#'+anchor if html and anchor else original_link
    direct = url(row.get('imageSource')) or url(row.get('imageUrl'))
    if html and anchor and original_link and original_link.split('#')[0] != html.split('#')[0]:
        direct = original_link
    if not figurl and page and pdf:
        figurl = pdf.split('#')[0] + '#page=' + str(page)
    if not (page and pdf) and not figurl:
        raise ValueError('missing source locator')
    crop = row.get('cropPdfPoints') or row.get('crop')
    if crop and (len(crop) != 4 or crop[2] <= crop[0] or crop[3] <= crop[1]):
        raise ValueError('invalid PDF crop')
    # Captions remain at the original. Preserve authored Chinese design notes, or use a short subject heading.
    raw_text = str(row.get('description') or row.get('lead') or row.get('caption') or row['title'])
    raw_text = re.sub(r'\\documentclass\b.*?\\end\s*\{document\}', ' ', raw_text, flags=re.S)
    raw_text = ' '.join(re.sub(r'[\ue000-\uf8ff]', '', raw_text).split()) or row['title']
    if re.search(r'[\u3400-\u9fff]', raw_text):
        description = raw_text[:230]
    else:
        subject = re.sub(r'^(?:(?:Fig(?:ure)?\.?)\s*\d+[.:]?\s+|[a-z]\.\s+|[.]+\s*)', '', raw_text, flags=re.I)
        # A period after "Fig.", a panel letter or "U.S." does not finish a short heading.
        first = re.split(r'(?<=[.!?])\s+',subject,maxsplit=1)[0]
        words = (first if len(first.split()) >= 4 else subject).split()
        description = ' '.join(words[:17]) + ('…' if len(words) > 17 else '')
    info = dict(category=category, collection='journal', sha256=enc['hash'], description=description,
                sourceUrl=url(row.get('sourceUrl')) or figurl)
    topic_text = row['title'] + ' ' + str(row.get('lead') or row.get('caption') or raw_text)
    topics = [key for key, rule in PAPER_TOPICS.items() if re.search(rule, topic_text, re.I)]
    if topics: info['topics'] = topics
    if pdf:
        info['pdfVersion'] = 'publisher' if row.get('sourceVersion') == 'publisher' else 'author-public'
    if crop and page and pdf:
        info['cropPdfPoints'] = [round(float(x), 3) for x in crop]
        pdf_hash = row.get('pdfSha256')
        if not pdf_hash and src.parent.name == 'ieee-neural':
            f = base / 'pdf' / (doi.split('/')[-1]+'.pdf')
            if f.exists():
                pdf_hash = file_hash(f)
        if pdf_hash:
            info['pdfSha256'] = pdf_hash
    if direct and not row.get('preferPdfCrop'):
        info['imageSource'] = direct
    panels = row.get('imagePanels')
    if panels:
        sizes = row.get('panelRows')
        if row.get('panelLayout') == 'vertical' and sizes is None:
            sizes = [1] * len(panels)
        if (row.get('panelLayout') not in ('vertical', 'rows') or not isinstance(sizes, list) or
                not 2 <= len(panels) <= 12 or not all(type(n) is int and 1 <= n <= 4 for n in sizes) or
                sum(sizes) != len(panels) or any(not url(p.get('url')) or not isinstance(p.get('label'), str)
                or len(p['label']) > 120 for p in panels)):
            raise ValueError('invalid numbered figure panels')
        if any(n > 1 for n in sizes):
            info['panelRows'] = sizes
        rendered_panels = []
        for panel in panels:
            item = dict(url=panel['url'], label=panel['label'])
            if 'width' in panel or 'height' in panel:
                if any(type(panel.get(k)) not in (float, int) or not 0 < panel[k] <= 90000 for k in ('width', 'height')):
                    raise ValueError('invalid panel display size')
                item.update(width=panel['width'], height=panel['height'])
            rendered_panels.append(item)
        info['imagePanels'] = rendered_panels
        info.pop('imageSource', None)
    if lic and open_license(row, lic, base):
        info['license'] = lic
    if category == 'result':
        dims = list(dict.fromkeys(row.get('dimensions') or []))
        tags = list(dict.fromkeys([*(row.get('forms') or []), *forms]))
        if not dims or not set(dims) <= {'2d','3d'} or not tags:
            raise ValueError('missing verified result form/dimensions')
        info.update(dimensions=dims, forms=tags)
    ext = Path(enc['file']).suffix
    out = dict(id=ident, title=row['title'], authors=row['authors'], year=year, venue=row['journal'],
               doi=doi, paper='https://doi.org/' + doi, figure='Figure '+str(num),
               pattern={'result':'results','algorithm':'pipeline','mechanism':'conceptual'}[category],
               image=f'journals/images/{ident}{ext}', w=enc['w'], h=enc['h'], supplement=info)
    if pdf:
        out['pdf_source'] = pdf
    if page and pdf:
        out['page'] = page
    if figurl:
        out['figureUrl'] = figurl
    if not (info.get('imageSource') or panels or (crop and page and pdf) or info.get('license')):
        raise ValueError('no reproducible open figure source')
    return out, enc, folder, original


def near_copy(a, b):
    if abs(a[1]['w'] / a[1]['h'] / (b[1]['w'] / b[1]['h']) - 1) > .012:
        return False
    def sample(item):
        with Image.open(item[3]) as im:
            return np.asarray(im.convert('RGB').resize((256, 256), Image.Resampling.LANCZOS), dtype=np.int16)
    x, y = sample(a), sample(b)
    ink = np.minimum(x.min(axis=2), y.min(axis=2)) < 225
    diff = np.abs(x-y)
    return bool(ink.any() and diff.mean() < .58 and diff[ink].mean() < 1.45 and (diff.max(axis=2)>18).mean() < .003)


def write_archive_entry(pack, name, payload):
    entry = zipfile.ZipInfo(name, (2026, 11, 24, 0, 0, 0))
    entry.external_attr = 0o644 << 16
    pack.writestr(entry, payload, compress_type=zipfile.ZIP_STORED)
    z = pack.getinfo(name)
    return dict(offset=z.header_offset+30+len(name.encode('ascii'))+len(z.extra), length=z.file_size)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('manifests', type=Path, nargs='+')
    ap.add_argument('--work', required=True, type=Path, help='Private staging and public release asset directory')
    ap.add_argument('--form-tags', type=Path, action='append', default=[], help='Array of {doi,figure,forms} records')
    ap.add_argument('--output', type=Path, default=ROOT/'resources/paper-gallery/journals', help='Journal catalog directory')
    ap.add_argument('--encoding-cache', type=Path, help='Reuse verified lossless masters across releases')
    ap.add_argument('--jobs', type=int, default=5)
    ap.add_argument('--require-targets', action='store_true')
    args = ap.parse_args()
    args.work.mkdir(exist_ok=True, parents=True)
    out = args.output
    args.encoding_cache = args.encoding_cache or args.work / 'encoding'
    forms = defaultdict(list)
    for f in args.form_tags:
        for row in json_file(f):
            forms[key(row)].extend(row['forms'])
    excluded_keys = {key(r) for r in json_file(ROOT/'scripts/gallery-editorial-exclusions.json')['figures']}
    jobs = [(f, r, forms[key(r)], args) for f in args.manifests for r in json_file(f) if key(r) not in excluded_keys]
    def safe(job):
        try:
            return one(job), None
        except (OSError, ValueError, KeyError) as exc:
            return None, {'doi':job[1].get('doi'), 'figure':job[1].get('figure'), 'reason':str(exc)}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        rows, rejected = [], []
        for item, err in pool.map(safe, jobs):
            if err: rejected.append(err)
            else: rows.append(item)
    rows.sort(key=lambda item:(item[0]['venue'], -item[0]['year'], item[0]['doi'], int(item[0]['figure'][7:])))
    kept, each, byte_hash, buckets = [], set(), {}, defaultdict(list)
    for item in rows:
        row, en, _, _ = item
        doi_fig = row['doi'],row['figure']
        p = int(en['phash'],16)
        keys = [(i,(p>>(16*i)) & 65535) for i in range(4)]
        similar = set(j for k in keys for j in buckets[k])
        match = next((j for j in similar if (p ^ int(kept[j][1]['phash'],16)).bit_count()<=3 and near_copy(item,kept[j])),None)
        if doi_fig in each or en['originalSha'] in byte_hash or match is not None:
            rejected.append(dict(doi=row['doi'],figure=row['figure'],reason='duplicate figure identity, bytes or visually equivalent crop'))
            continue
        for k in keys: buckets[k].append(len(kept))
        each.add(doi_fig); byte_hash[en['originalSha']]=row['id']; kept.append(item)
    counts = Counter(row[0]['supplement']['category'] for row in kept)
    compact(args.work/'excluded.json',rejected)
    if args.require_targets and not all(counts[k]>=n for k,n in [('result',2000),('algorithm',800),('mechanism',800)]):
        raise SystemExit(f'After deduplication: {counts}')
    version = json_file(ROOT/'package.json')['version']
    archive = args.work/f'MK-Figure-{version}-Open-Figures.zip'
    output_zip = archive.with_suffix('.zip.part')
    credits, private, records = [], [], []
    with zipfile.ZipFile(output_zip,'w',allowZip64=True) as pack:
        for row, enc, folder, _ in kept:
            source = folder/enc['file']
            local = out.parent/row['image']
            link_or_copy(source,local)
            preview = folder/(enc['originalSha']+'-preview.webp')
            inf = row['supplement']
            if inf.get('license'):
                inf['archive'] = write_archive_entry(pack,row['image'],source.read_bytes())
                link_or_copy(preview,out/'previews'/(row['id']+'.webp'))
                credits.append(dict(figure=row['figure'],title=row['title'],authors=row['authors'],paper=row['paper'],
                                    source=row.get('figureUrl') or row['paper'],license=inf['license'],file=row['image']))
            private.append(dict(id=row['id'],sha=enc['hash'],ext=source.suffix,source=str(local),preview=str(preview)))
            records.append(row)
        write_archive_entry(pack,'CREDITS.json',json.dumps(credits,ensure_ascii=False,indent=1).encode())
        write_archive_entry(pack,'README.txt',f'Open journal figures for MK Figure {version}. CREDITS.json identifies the authors, title, numbered figure, source and license of each file. Preparation includes extracting or cropping the numbered figure, trimming margins, resizing and raster encoding for on-screen viewing. The subsequent storage optimization preserved every decoded figure pixel. Scientific values and labels are those of the original authors.\n'.encode())
    output_zip.replace(archive)
    # A license change must also remove a preview produced by an earlier run.
    for directory, keep in [(out/'previews',{r['id']+'.webp' for r in records if r['supplement'].get('archive')}),
                            (out/'images',{Path(r['image']).name for r in records})]:
        if not directory.is_dir(): continue
        for old in directory.glob('mk-j-*'):
            if (old.name not in keep and re.fullmatch(r'mk-j-[a-z]+-[a-f0-9]{14}-f\d+\.(jpg|webp)',old.name)
                    and old.resolve().parent == directory.resolve()):
                old.unlink()
    # Verify every published range decodes to its advertised SHA-256 without opening the ZIP directory.
    with archive.open('rb') as stream:
        for row in records:
            inf = row['supplement']
            if 'archive' in inf:
                stream.seek(inf['archive']['offset'])
                assert sha(stream.read(inf['archive']['length'])) == inf['sha256']
    compact(args.work/'offline-install.json',private)
    compact(out/'figures.json',records)
    write_index([r['id'] for r in records], [[r['title'],r['supplement']['description'],r['venue'],r['supplement']['category'],
                *r['supplement'].get('forms',[]),*r['supplement'].get('dimensions',[])] for r in records],
                ROOT/'resources/layout-index/concepts.json',out/'layout-terms.json.gz')
    stat=dict(archiveVersion=version,cardPreviewProfile=CARD_PREVIEW_PROFILE,figures=len(records),papers=len({r['doi'] for r in records}),category=dict(counts),years=dict(Counter(r['year'] for r in records)),
              venues=dict(Counter(r['venue'] for r in records)),dimensions=dict(Counter('+'.join(sorted(r['supplement']['dimensions'])) for r in records if r['supplement']['category']=='result')),
              forms=dict(Counter(t for r in records for t in r['supplement'].get('forms',[]))), openImages=len(credits),
              originalBytes=sum(r[1]['originalBytes'] for r in kept), storedBytes=sum(r[1]['bytes'] for r in kept), archiveBytes=archive.stat().st_size,
              previewsBytes=sum((out/'previews'/(r['id']+'.webp')).stat().st_size for r in records if 'archive' in r['supplement']),
              losslessWebP=sum(r[1]['file'].endswith('.webp') for r in kept),
              losslessJpeg=sum(bool(r[1].get('optimizedJpeg')) for r in kept), sourceFiguresExcluded=len(rejected), editorialExclusions=len(excluded_keys))
    compact(out/'coverage.json',stat)
    print(json.dumps(stat,ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
