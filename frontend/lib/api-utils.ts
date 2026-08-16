import { NextResponse } from "next/server";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function jsonNoStore(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

const IP_HEADER_NAMES = [
  "x-forwarded-for",
  "x-vercel-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "x-forwarded",
  "forwarded",
] as const;

function unwrapIp(value: string) {
  let ip = value.trim();

  if (!ip) {
    return "";
  }

  const forwardedFor = ip.match(/^for=(?:"?\[?)([^\]";]+)/i);

  if (forwardedFor) {
    ip = forwardedFor[1].trim();
  }

  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    ip = end >= 0 ? ip.slice(1, end) : ip.replace(/^\[|\]$/g, "");
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }

  return ip.split("%")[0]?.trim() ?? "";
}

function mappedIpv4(ip: string) {
  return ip.match(/(?:^|:)(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? null;
}

function isPrivateOrLoopback(ip: string) {
  const normalized = unwrapIp(ip);

  if (!normalized) {
    return true;
  }

  const v4 = mappedIpv4(normalized) ?? (normalized.includes(":") ? null : normalized);

  if (v4) {
    const [a, b] = v4.split(".").map((part) => Number(part));

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const compact = normalized.toLowerCase();

  return (
    compact === "::" ||
    compact === "::1" ||
    compact === "0:0:0:0:0:0:0:0" ||
    compact === "0:0:0:0:0:0:0:1" ||
    compact.startsWith("fe80:") ||
    compact.startsWith("fc") ||
    compact.startsWith("fd")
  );
}

function isIpv4Like(ip: string) {
  const normalized = unwrapIp(ip);
  return Boolean(mappedIpv4(normalized) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized));
}

function collectIps(headerList: Array<Headers | null | undefined>) {
  const ips: string[] = [];

  for (const headerStore of headerList) {
    if (!headerStore) {
      continue;
    }

    for (const name of IP_HEADER_NAMES) {
      const raw = headerStore.get(name);

      if (!raw) {
        continue;
      }

      for (const part of raw.split(",")) {
        const ip = unwrapIp(part);

        if (ip) {
          ips.push(ip);
        }
      }
    }
  }

  return ips;
}

export function getRequestIp(request: Request, extraHeaders?: Headers) {
  const ips = collectIps([extraHeaders, request.headers]);
  const publicIps = ips.filter((ip) => !isPrivateOrLoopback(ip));
  const publicIpv4 = publicIps.find((ip) => isIpv4Like(ip));

  return publicIpv4 ?? publicIps[0] ?? ips[0] ?? null;
}
