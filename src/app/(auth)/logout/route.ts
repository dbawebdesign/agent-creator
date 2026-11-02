import { NextResponse } from "next/server";
import { destroySession } from "@/server/auth/session";
import { env } from "@/server/env";

/** POST /logout — ends the session (form posts only, so links can't sign people out). */
export async function POST() {
  await destroySession();
  return NextResponse.redirect(new URL("/login", env().APP_URL), 303);
}
