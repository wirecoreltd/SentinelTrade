import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_API_SECRET;

  const diagnostics = {
    runtime: "nodejs",
    binanceApiKeyConfigured: Boolean(apiKey),
    binanceSecretConfigured: Boolean(secretKey),
    binanceBaseUrl:
      process.env.BINANCE_BASE_URL || "https://testnet.binance.vision",
    vercelRegion: process.env.VERCEL_REGION || "unknown",
    vercelEnvironment: process.env.VERCEL_ENV || "unknown",
  };

  try {
    const response = await fetch(
      "https://testnet.binance.vision/api/v3/time",
      {
        method: "GET",
        cache: "no-store",
      }
    );

    const data = await response.json();

    return NextResponse.json({
      diagnostics,
      binanceConnection: {
        status: response.status,
        ok: response.ok,
        response: data,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        diagnostics,
        binanceConnection: {
          ok: false,
          error: error.message,
        },
      },
      { status: 500 }
    );
  }
}
