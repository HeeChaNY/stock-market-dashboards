import argparse
import io
import json
import os
import urllib.request
import zipfile
from datetime import datetime
from zoneinfo import ZoneInfo


KOSPI_WIDTHS = [
    2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1,
    1, 2, 2, 2, 3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 1, 9,
    9, 9, 5, 9, 8, 9, 3, 1, 1, 1,
]
KOSDAQ_WIDTHS = [
    2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 3,
    1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8, 9,
    3, 1, 1, 1,
]


def download_master(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    member = next(name for name in archive.namelist() if name.lower().endswith(".mst"))
    return archive.read(member).decode("cp949").splitlines()


def parse_fixed_width(text, widths):
    values = []
    offset = 0
    for width in widths:
        values.append(text[offset:offset + width].strip())
        offset += width
    return values


def parse_market(lines, tail_length, widths, listed_shares_index, market_cap_index, reference_price_index, multiplier, market):
    entries = {}
    for line in lines:
        if len(line) <= tail_length:
            continue
        code = line[:9].strip()
        if not (len(code) == 6 and code.isdigit()):
            continue
        name = line[21:-tail_length].strip()
        fields = parse_fixed_width(line[-tail_length:], widths)
        try:
            shares = int(fields[listed_shares_index] or "0") * multiplier
            market_cap_won = int(fields[market_cap_index] or "0") * 100_000_000
            reference_price = int(fields[reference_price_index] or "0")
        except (ValueError, IndexError):
            continue
        if shares > 0 and name:
            entries[code] = {
                "shares": shares,
                "name": name,
                "market": market,
                "marketCapWon": market_cap_won,
                "referencePrice": reference_price,
                "productType": fields[0],
            }
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    today = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y%m%d")
    kospi = download_master("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip")
    kosdaq = download_master("https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip")
    entries = {}
    # The official sample slices 228/222 characters including the trailing newline.
    # splitlines() removes that newline, so the fixed-width payloads are 227/221.
    entries.update(parse_market(kospi, sum(KOSPI_WIDTHS), KOSPI_WIDTHS, 50, 65, 31, 1000, "유가"))
    entries.update(parse_market(kosdaq, sum(KOSDAQ_WIDTHS), KOSDAQ_WIDTHS, 45, 59, 26, 1000, "코스닥"))
    if len(entries) < 2000 or entries.get("005930", {}).get("name") != "삼성전자" or entries.get("001820", {}).get("name") != "삼화콘덴서":
        raise RuntimeError(f"KIS master validation failed: {len(entries)} entries")
    payload = {
        "version": 6,
        "updatedDate": today,
        "entries": {code: {**entry, "checkedDate": today, "source": "KIS_MASTER"} for code, entry in entries.items()},
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps({"count": len(entries), "date": today, "samsung": entries["005930"], "skhynix": entries["000660"], "samwha": entries["001820"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
