-- 047_enterprise_team.sql — 商业化补充: 企业租户流程（企业注册/成员邀请）
-- V389+
CREATE TABLE IF NOT EXISTS tenant_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  inviter_user_id uuid NOT NULL,
  invitee_username text NOT NULL,     -- 被邀请的用户名
  role text NOT NULL DEFAULT 'member', -- owner | admin | member
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_invites ON tenant_invites (invitee_username, status);

-- tenant_members 已有; 补成员列表查询索引
CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members (user_id);
