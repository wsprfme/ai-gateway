// Impor kredensial langganan dari aplikasi yang sudah login di komputer ini (tanpa login browser lagi).
// - Codex (ChatGPT app / Codex): ~/.codex/auth.json  → dibaca langsung.
// - Antigravity (Google): Windows Credential Manager "gemini:antigravity" → dibaca via PowerShell CredRead.
//
// Hanya berguna saat gateway jalan di mesin yang sama dengan aplikasinya. Nilai token tidak pernah
// ditulis ke log; hanya diteruskan ke keypool (terenkripsi di DB).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODEX_AUTH = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

export function readCodexAuth() {
  const p = CODEX_AUTH();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Baca blob kredensial dari Windows Credential Manager. Blob-nya JSON polos (bukan DPAPI).
const AG_CRED_TARGET = 'LegacyGeneric:target=gemini:antigravity';
const CRED_PS = `
$sig = @'
using System;using System.Runtime.InteropServices;
public static class C {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct CRED {
    public int Flags;public int Type;public string TargetName;public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int BlobSize;public IntPtr Blob;public int Persist;public int AttributeCount;
    public IntPtr Attributes;public string TargetAlias;public string UserName; }
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool CredRead(string t,int ty,int f,out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
  public static byte[] Read(string t){ IntPtr p; if(!CredRead(t,1,0,out p)) return null;
    try{ var c=Marshal.PtrToStructure<CRED>(p); var b=new byte[c.BlobSize]; Marshal.Copy(c.Blob,b,0,c.BlobSize); return b; } finally{ CredFree(p); } }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
$b = [C]::Read('${AG_CRED_TARGET}')
if ($b) { [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)) }
`;

export function readAntigravityCred() {
  if (process.platform !== 'win32') return null;
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', CRED_PS], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!out || !out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Apa yang bisa diimpor dari mesin ini (tanpa membuka nilai token).
export function scanLocal() {
  const codex = readCodexAuth();
  const ag = readAntigravityCred();
  const codexT = codex?.tokens || codex || {};
  return {
    codex: {
      available: !!codexT.access_token,
      path: CODEX_AUTH(),
      account: codexT.account_id || null,
    },
    antigravity: {
      available: !!ag?.token?.access_token,
      source: process.platform === 'win32' ? 'Windows Credential Manager' : 'tidak didukung di OS ini',
      email: ag?.id_token_email || null,
    },
  };
}

// Ubah blob Antigravity → bentuk cred standar adapter.
export function antigravityCredToStd(raw) {
  const t = raw?.token || {};
  if (!t.access_token) throw new Error('Kredensial Antigravity tidak berisi access_token.');
  const expiresAt = t.expiry ? Date.parse(t.expiry) : t.expires_in ? Date.now() + t.expires_in * 1000 : null;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    meta: { email: raw.id_token_email || null, writerId: raw.writer_id || null },
  };
}
