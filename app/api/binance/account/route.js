import { NextResponse } from "next/server";
import crypto from "crypto";

export async function GET() {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_API_SECRET;

    if (!apiKey || !secretKey) {
      return NextResponse.json(
        { error: "Binance API keys are not configured" },
        { status: 500 }
      );
    }

    const timestamp = Date.now();

    const queryString = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(queryString)
      .digest("hex");

    const response = await fetch(
      `https://testnet.binance.vision/api/v3/account?${queryString}&signature=${signature}`,
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
          error: "Binance API error",
          details: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      accountType: data.accountType,
      balances: data.balances,
    });
  } catch (error) {
    console.error("Binance account error:", error);

    return NextResponse.json(
      {
        error: "Failed to connect to Binance Testnet",
      },
      { status: 500 }
    );
  }
}
