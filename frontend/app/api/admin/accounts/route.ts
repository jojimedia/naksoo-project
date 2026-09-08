import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { createAdmin, getAdmin, listAdminProfiles } from "@/lib/operations-store";

async function requireRoot() { const session=await getSessionFromCookies(); if(!session) throw new Error("로그인이 필요합니다."); const admin=await getAdmin(session.loginId); if(!admin?.is_superadmin) throw new Error("최고 관리자만 계정을 관리할 수 있습니다."); }
export async function GET(){ try { await requireRoot(); return NextResponse.json({accounts:await listAdminProfiles()}); } catch(error) { return jsonError(error instanceof Error?error.message:"계정 목록 조회에 실패했습니다.",401); } }
export async function POST(request:Request){ try { await requireRoot(); const body=await request.json() as {login_id?:string;crews?:string[]}; const account=await createAdmin(body.login_id??"",Array.isArray(body.crews)?body.crews:[]); return NextResponse.json({ok:true,account,temporary_password:"1234"}); } catch(error) { return jsonError(error instanceof Error?error.message:"계정 생성에 실패했습니다.",400); } }
