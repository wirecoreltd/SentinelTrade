import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BINANCE_DATA_URL =
  process.env.BINANCE_DATA_BASE_URL ||
  "https://data-api.binance.vision";

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const symbol = searchParams.get("symbol");
  const interval = searchParams.get("interval") || "1h";
  const limit = searchParams.get("limit") || "100";

  if (!symbol) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing symbol parameter.",
      },
      { status: 400 }
    );
  }

  try {
    const url = new URL("/api/v3/klines", BINANCE_DATA_URL);

    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", limit);

    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: response.status,
          error: data?.msg || "Binance market data request failed.",
          response: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,
      source: "Binance Market Data",
      symbol: symbol.toUpperCase(),
      interval,
      limit: Number(limit),
      data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Unable to retrieve Binance market data.",
      },
      { status: 500 }
    );
  }
}
