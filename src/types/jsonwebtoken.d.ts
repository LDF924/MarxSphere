// jsonwebtoken.d.ts — 本地类型声明（无 @types/jsonwebtoken）
declare module "jsonwebtoken" {
  export interface SignOptions { expiresIn?: string | number; algorithm?: string; }
  export function sign(payload: object, secret: string, options?: SignOptions): string;
  export function verify(token: string, secret: string): any;
  export function decode(token: string): any;
}
