import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';

// THE CONTENT-LANGUAGE seed (Story MOTIR-7731 · MOTIR-8100), for the receipt
// `regression-content-language.spec.ts` records.
//
// An organisation as the content-language migration leaves an existing one —
// created with no language named, so it reads `en` — with its owner, a plain
// member, a project, and two work items written BEFORE any change: one whose
// languages were recorded (`en`), and one with the columns NULL, the state of
// everything written before content languages existed. Plus a token for the
// owner, so the spec reads languages back over `/api/mcp` the way an agent does.

export const CONTENT_LANGUAGE_PASSWORD = 'content-language-e2e-9';
export const OLD_RECORDED_TITLE = 'Draft the release notes';
export const OLD_UNRECORDED_TITLE = 'Write the onboarding email';

export interface ContentLanguageSeed {
  orgId: string;
  ownerEmail: string;
  memberEmail: string;
  oldRecordedKey: string;
  oldUnrecordedKey: string;
  token: string;
}

export async function seedContentLanguageOrg(): Promise<ContentLanguageSeed> {
  const slug = Date.now().toString(36);
  const ownerEmail = `cl-owner-${slug}@example.com`;
  const memberEmail = `cl-member-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: CONTENT_LANGUAGE_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Content Language E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Launch',
    identifier: 'LANG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.updateMany({
    where: { userId: owner.id, workspaceId: workspace.id },
    data: { activeProjectId: project.id },
  });

  const member = await createTestPerson({
    email: memberEmail,
    password: CONTENT_LANGUAGE_PASSWORD,
    name: 'Max Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const recorded = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: OLD_RECORDED_TITLE,
      descriptionMd: 'List what shipped this week.',
    },
    ctx,
  );
  const unrecorded = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: OLD_UNRECORDED_TITLE,
      descriptionMd: 'Welcome new teams.',
    },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: unrecorded.id },
    data: { titleLanguage: null, descriptionLanguage: null, explanationLanguage: null },
  });

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'content-language-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    orgId: workspace.organizationId,
    ownerEmail,
    memberEmail,
    oldRecordedKey: recorded.identifier,
    oldUnrecordedKey: unrecorded.identifier,
    token: minted.token,
  };
}

export type FieldLanguages = {
  title: string | null;
  description: string | null;
  explanation: string | null;
};

/** An MCP client on `/api/mcp`, authenticated as the seed's owner. */
export async function openMcp(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'content-language-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** Call one tool and return its structured payload, failing on a tool error. */
export async function mcp<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
  return res.structuredContent as T;
}

/** A work item's recorded languages, read through `get_work_item`. */
export async function languagesOf(client: Client, key: string): Promise<FieldLanguages> {
  return (await mcp<{ item: { languages: FieldLanguages } }>(client, 'get_work_item', { key })).item
    .languages;
}
