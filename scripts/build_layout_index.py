"""Build the MK Figure offline layout-search corpus from a FigureForge checkout."""

import argparse
import gzip
import json
import re
from collections import defaultdict
from pathlib import Path


def build(source, output):
    def read(name):
        return json.loads((source / "forge" / "data" / name).read_text(encoding="utf-8"))

    figures, ids, docs = read("figures.json"), read("ids.json"), read("bm25.json")["docs"]
    if [f["id"] for f in figures] != ids or len(ids) != len(docs) or len(set(ids)) != len(ids):
        raise ValueError("The source corpus and figure IDs must align one-to-one.")
    extra = json.loads((output.parent / "paper-gallery" / "supplement" / "figures.json").read_text(encoding="utf-8"))
    for row in extra:
        info = row["supplement"]
        ids.append(row["id"])
        docs.append([row["title"], info["description"], row["pattern"], info["category"],
                     *info.get("dimensions", []), *info.get("forms", [])])
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate figure IDs across the two collections.")
    write_index(ids, docs, output / "concepts.json", output / "paper-terms.json.gz")


def write_index(ids, docs, concepts_file, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    concepts = json.loads(concepts_file.read_text(encoding="utf-8"))
    phrases = {term for group in concepts for term in group["terms"] if " " in term}
    postings = defaultdict(list)
    stop = set("a an and are as at be by for from in into is it of on or that the this to we with".split())
    for index, doc in enumerate(docs):
        words = re.findall(r"[a-z0-9]+", " ".join(doc).lower())
        text = " " + " ".join(words) + " "
        terms = {word for word in words if word not in stop}
        terms.update(phrase for phrase in phrases if f" {phrase} " in text)
        for term in terms:
            postings[term].append(index)
    corpus = {"version": 1, "ids": ids, "terms": dict(sorted(postings.items()))}
    data = json.dumps(corpus, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    target.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))
    print(f"{len(ids)} indexed figures, {len(postings)} non-positional terms")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Upstream repository checkout")
    parser.add_argument("output", type=Path, help="Path to resources/layout-index")
    args = parser.parse_args()
    build(args.source, args.output)
