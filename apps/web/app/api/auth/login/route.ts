import { createLoginHandler } from "@/lib/auth/route-handlers";

const loginHandler = createLoginHandler();

export async function POST(request: Request): Promise<Response> {
  return loginHandler(request);
}
