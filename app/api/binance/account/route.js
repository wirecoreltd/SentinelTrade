import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ENDPOINTS = [
  {
    name: "Binance Spot Testnet",
    url: "https://testnet.binance.vision/api/v3/time",
  },
  {
    name: "Binance Production",
    url: "https://api.binance.com/api/v3/time",
  },
  {
    name: "Binance GCP",
    url: "https://api-gcp.binance.com/api/v3/time",
  },
  {
    name: "Binance API 1",
    url: "https://api1.binance.com/api/v3/time",
  },
  {
    name: "Binance API 2",
    url: "https://api2.binance.com/api/v3/time",
  },
  {
    name: "Binance API 3",
    url: "https://api3.binance.com/api/v3/time",
  },
  {
    name: "Binance API 4",
    url: "https://api4.binance.com/api/v3/time",
  },
  {
    name: "Binance Market Data",
    url: "https://data-api.binance.vision/api/v3/time",
  },
];

export async function GET() {
  const results = [];

  for (const endpoint of ENDPOINTS) {
    const startedAt = Date.now();

    try {
      const response = await fetch(endpoint.url, {
        method: "GET",
        cache: "no-store",
      });

      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      results.push({
        name: endpoint.name,
        url: endpoint.url,
        status: response.status,
        ok: response.ok,
        response: data,
        responseTimeMs: Date.now() - startedAt,
      });
    } catch (error) {
      results.push({
        name: endpoint.name,
        url: endpoint.url,
        status: null,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown connection error",
        responseTimeMs: Date.now() - startedAt,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    testedFrom: "Vercel",
    results,
  });
}
