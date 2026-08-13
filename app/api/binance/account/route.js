import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

const BINANCE_BASE_URL =
  process.env.BINANCE_BASE_URL || "https://testnet.binance.vision";

export async function GET() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_API_SECRET;

  if (!apiKey || !secretKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Les clés Binance Testnet ne sont pas configurées.",
      },
      { status: 500 }
    );
  }

  try {
    const timestamp = Date.now();

    const queryString = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(queryString)
      .digest("hex");

    const response = await fetch(
      `${BINANCE_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`,
      {
        method: "GET",
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
        cache: "no-store",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: response.status,
          error: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,
      account: {
        canTrade: data.canTrade,
        canWithdraw: data.canWithdraw,
        canDeposit: data.canDeposit,
      },
      balances: data.balances,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Erreur inconnue",
      },
      { status: 500 }
    );
  }
}
