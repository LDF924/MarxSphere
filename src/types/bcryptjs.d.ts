// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// bcryptjs.d.ts — 本地类型声明（无 @types/bcryptjs）
declare module "bcryptjs" {
  export function hash(s: string, salt: number): Promise<string>;
  export function compare(s: string, hash: string): Promise<boolean>;
  export function genSalt(rounds?: number): Promise<string>;
}
