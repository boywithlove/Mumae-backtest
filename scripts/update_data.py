"""야후 파이낸스 일봉(OHLC)을 받아 data/{티커}.json 으로 저장합니다.

- 가격은 액면분할만 반영된 값입니다 (auto_adjust=False → Open/High/Low/Close, 배당 미반영).
- 장이 아직 진행 중인 오늘 캔들(미완성 봉)은 저장하지 않습니다.
- GitHub Actions(.github/workflows/update-data.yml)가 미국장 마감 후 매일 실행합니다.

사용법: python scripts/update_data.py [티커 ...]   (생략 시 tickers.txt 전체)
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def load_tickers():
    lines = (ROOT / "tickers.txt").read_text(encoding="utf-8").splitlines()
    return [ln.split("#")[0].strip().upper() for ln in lines if ln.split("#")[0].strip()]


def ny_today():
    # 뉴욕 날짜 (서머타임 무시해도 마감 후 실행이라 하루 단위 판정에는 충분)
    return (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")


def market_closed_for_today():
    now = datetime.now(timezone.utc) - timedelta(hours=5)
    return now.hour >= 17  # 뉴욕 기준 17시 이후면 오늘 봉 확정


def fetch(ticker):
    df = yf.Ticker(ticker).history(period="max", auto_adjust=False, actions=False)
    if df.empty:
        raise RuntimeError(f"{ticker}: 데이터 없음")
    df = df[df["Close"].notna()]
    rows = []
    for idx, r in df.iterrows():
        d = idx.strftime("%Y-%m-%d")
        rows.append([d, round(float(r["Open"]), 4), round(float(r["High"]), 4),
                     round(float(r["Low"]), 4), round(float(r["Close"]), 4)])
    if rows and rows[-1][0] == ny_today() and not market_closed_for_today():
        rows.pop()
    return rows


def main(argv):
    DATA.mkdir(exist_ok=True)
    tickers = [t.upper() for t in argv] or load_tickers()
    ok, failed = [], []
    for t in tickers:
        try:
            rows = fetch(t)
            (DATA / f"{t}.json").write_text(json.dumps({"ticker": t, "rows": rows}, separators=(",", ":")),
                                            encoding="utf-8")
            ok.append(t)
            print(f"{t}: {len(rows)}일 ({rows[0][0]} ~ {rows[-1][0]})")
        except Exception as e:  # 한 종목 실패가 전체를 막지 않도록
            failed.append(t)
            print(f"{t}: 실패 - {e}", file=sys.stderr)
    existing = sorted(p.stem for p in DATA.glob("*.json") if p.stem != "tickers")
    (DATA / "tickers.json").write_text(json.dumps(existing), encoding="utf-8")
    if failed and not ok:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
