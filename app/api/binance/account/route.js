import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

export async function GET() {
  const apiKey = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_API_SECRET;
  const baseUrl =
    process.env.BINANCE_BASE_URL || "https://testnet.binance.vision";

  if (!apiKey || !secretKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Binance API credentials are not configured.",
        diagnostics: {
          apiKeyConfigured: Boolean(apiKey),
          secretConfigured: Boolean(secretKey),
          baseUrl,
        },
      },
      { status: 500 }
    );
  }

  try {
    // 1. Récupérer l'heure du serveur Binance
    const timeResponse = await fetch(
      `${baseUrl}/api/v3/time`,
      {
        method: "GET",
        cache: "no-store",
      }
    );

    if (!timeResponse.ok) {
      const errorText = await timeResponse.text();

      return NextResponse.json(
        {
          ok: false,
          error: "Unable to retrieve Binance server time.",
          status: timeResponse.status,
          response: errorText,
        },
        { status: 502 }
      );
    }

    const timeData = await timeResponse.json();
    const timestamp = timeData.serverTime;

    // 2. Construire la requête signée
    const queryString = `timestamp=${timestamp}&recvWindow=5000`;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(queryString)
      .digest("hex");

    // 3. Appel authentifié au compte Binance
    const accountResponse = await fetch(
      `${baseUrl}/api/v3/account?${queryString}&signature=${signature}`,
      {
        method: "GET",
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
        cache: "no-store",
      }
    );

    const accountData = await accountResponse.json();

    if (!accountResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Binance rejected the account request.",
          status: accountResponse.status,
          response: accountData,
        },
        { status: accountResponse.status }
      );
    }

    // 4. Retourner uniquement les informations nécessaires
    return NextResponse.json({
      ok: true,
      account: accountData,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Binance connection error.",
      },
      { status: 500 }
    );
  }
}
