import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BINANCE_DATA_URL = "https://data-api.binance.vision";

const INTERVALS = {
  "1j": "1h",
  "5j": "1h",
  "1m": "4h",
  "3m": "1d",
};

const LIMITS = {
  "1j": 24,
  "5j": 120,
  "1m": 180,
  "3m": 90,
};

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const symbol = searchParams.get("symbol")?.toUpperCase();
    const range = searchParams.get("range") || "5j";

    if (!symbol) {
      return NextResponse.json(
        {
          ok: false,
          error: "Symbol manquant.",
        },
        { status: 400 }
      );
    }

    if (!INTERVALS[range]) {
      return NextResponse.json(
        {
          ok: false,
          error: `Range invalide: ${range}`,
        },
        { status: 400 }
      );
    }

    const interval = INTERVALS[range];
    const limit = LIMITS[range];

    const url =
      `${BINANCE_DATA_URL}/api/v3/klines` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&limit=${limit}`;

    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "Réponse Binance invalide.",
          status: response.status,
          response: text,
        },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: data?.msg || "Erreur Binance.",
          status: response.status,
          response: data,
        },
        { status: response.status }
      );
    }

    const candles = data.map((candle) => ({
      date: Number(candle[0]),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]),
    }));

    return NextResponse.json({
      ok: true,
      source: "Binance Market Data",
      symbol,
      interval,
      range,
      candles,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Erreur serveur.",
      },
      { status: 500 }
    );
  }
}
