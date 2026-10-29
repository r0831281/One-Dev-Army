import { randomUUID } from "node:crypto";
import {
  compilePrompt,
  validateProfile,
  type AgentProfile,
  type CompileInput,
  type PromptArtifact,
} from "../../prompt-compiler/src/index.js";
export class ProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile[]>();
  private readonly artifacts = new Map<string, PromptArtifact>();
  list(): AgentProfile[] {
    return [...this.profiles.values()].flatMap((revisions) =>
      revisions.map((profile) => structuredClone(profile)),
    );
  }
  create(value: AgentProfile): AgentProfile {
    const profile = validateProfile(value);
    const revisions = this.profiles.get(profile.id) ?? [];
    if (revisions.some((entry) => entry.revision === profile.revision))
      throw new Error("PROFILE_REVISION_EXISTS");
    if (
      revisions.length > 0 &&
      profile.revision !== Math.max(...revisions.map((entry) => entry.revision)) + 1
    )
      throw new Error("PROFILE_REVISION_GAP");
    revisions.push(structuredClone(profile));
    this.profiles.set(profile.id, revisions);
    return structuredClone(profile);
  }
  get(id: string, revision?: number): AgentProfile | null {
    const values = this.profiles.get(id) ?? [];
    const profile =
      revision === undefined ? values.at(-1) : values.find((entry) => entry.revision === revision);
    return profile ? structuredClone(profile) : null;
  }
  async compile(
    id: string,
    revision: number,
    input: Omit<CompileInput, "profile">,
  ): Promise<{ artifactId: string; artifact: PromptArtifact }> {
    const profile = this.get(id, revision);
    if (!profile) throw new Error("PROFILE_NOT_FOUND");
    const artifact = await compilePrompt({ ...input, profile });
    const existing = [...this.artifacts.entries()].find(
      ([, value]) => value.promptHash === artifact.promptHash,
    );
    if (existing) return { artifactId: existing[0], artifact: structuredClone(existing[1]) };
    const artifactId = randomUUID();
    this.artifacts.set(artifactId, structuredClone(artifact));
    return { artifactId, artifact };
  }
}
