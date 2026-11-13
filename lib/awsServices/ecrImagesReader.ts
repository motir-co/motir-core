import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';

// THE FLEET STATUS PAGE'S INDEXER IMAGE READ (MOTIR-10986) — the images of ONE
// ECR repository in core's own account: the `motir/indexer` repository motir-ai's
// release lane mirrors every `indexer-v<x.y.z>` release into, tagged
// `indexer-<x.y.z>`. It lives beside `ecsServicesReader.ts` for the same reason
// (`tests/ciFleet/awsSdkBoundary.test.ts` registers the directory): the service
// that judges what it read sees plain objects and is tested offline.
//
// ⚠️ NO CREDENTIALS ARE PASSED. The client resolves them through the SDK's
// default chain, which on ECS is the web task's role; motir-infra grants it
// `ecr:DescribeImages` on that one repository (MOTIR-10988). The REGION and the
// registry come from the pinned reference itself, so the read asks the registry
// the pin names, not whichever region the task happens to run in.
//
// ⚠️ READS ONLY: DescribeImages. ECR returns no image labels there, so the build
// commit is not read here — the service reads it from motir-ai's git tag.
//
// THE SERVICES PAGE'S DEPLOYED-COMMIT READ (MOTIR-11112) uses the same call for
// ONE image at a time (`createEcrImageTagsReader`): the tags of the image a
// service's task definition runs, one of which every deploy sets to the full
// commit SHA. motir-infra grants `ecr:DescribeImages` on those repositories
// (MOTIR-11111).

/** A reference into ECR by digest: `<account>.dkr.ecr.<region>.amazonaws.com[.cn]/<repository>@sha256:<64 hex>`. */
const ECR_REFERENCE =
  /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)@(sha256:[a-f0-9]{64})$/;

/** How many DescribeImages pages are read (1000 images each) before the read fails. */
const MAX_PAGES = 10;

/** The ECR repository a reference names. */
export interface EcrRepositoryRef {
  registryId: string;
  region: string;
  repositoryName: string;
}

/** A pull-by-digest reference into ECR, split into its parts. */
export interface EcrImageReference extends EcrRepositoryRef {
  /** `<account>.dkr.ecr.<region>.amazonaws.com/<repository>`, the reference without its digest. */
  repositoryUri: string;
  digest: string;
}

/** One image of the repository, as ECR describes it. */
export interface EcrImageRead {
  digest: string;
  tags: string[];
  /** When the image was pushed (ISO 8601), or null when ECR gives none. */
  pushedAt: string | null;
}

export interface EcrImagesReader {
  /** Every image of the repository. Throws when ECR does not answer. */
  listImages(repository: EcrRepositoryRef): Promise<EcrImageRead[]>;
}

/** The reference's registry, region, repository and digest, or null when it is
 *  not a reference into ECR by digest (a GHCR or Fly registry reference). */
export function parseEcrImageReference(reference: string): EcrImageReference | null {
  const match = ECR_REFERENCE.exec(reference.trim());
  if (!match) return null;
  const [, registryId, region, repositoryName, digest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const at = reference.trim().lastIndexOf('@');
  return {
    registryId,
    region,
    repositoryName,
    repositoryUri: reference.trim().slice(0, at),
    digest,
  };
}

/** A reference into ECR by tag, by digest, or both:
 *  `<account>.dkr.ecr.<region>.amazonaws.com[.cn]/<repository>[:<tag>][@sha256:<64 hex>]`. */
const ECR_ANY_REFERENCE =
  /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/;

/** An image a task definition names in ECR — by tag, by digest, or both. */
export interface EcrImageAddress extends EcrRepositoryRef {
  tag: string | null;
  digest: string | null;
}

/** The registry, region, repository, tag and digest of a reference into ECR,
 *  or null when it is not one (a GHCR or Docker Hub image), or names neither a
 *  tag nor a digest. Used by the Services page (MOTIR-11112). */
export function parseEcrImageAddress(reference: string): EcrImageAddress | null {
  const match = ECR_ANY_REFERENCE.exec(reference.trim());
  if (!match) return null;
  const [, registryId, region, repositoryName, tag, digest] = match;
  if (!tag && !digest) return null;
  return {
    registryId: registryId!,
    region: region!,
    repositoryName: repositoryName!,
    tag: tag ?? null,
    digest: digest ?? null,
  };
}

/** The tags of ONE image (MOTIR-11112). Throws when ECR does not answer, or
 *  does not know the image. */
export interface EcrImageTagsReader {
  tagsOf(image: EcrImageAddress): Promise<string[]>;
}

function regionalClients(): (region: string) => ECRClient {
  const clients = new Map<string, ECRClient>();
  return (region) => {
    let client = clients.get(region);
    if (!client) {
      client = new ECRClient({ region });
      clients.set(region, client);
    }
    return client;
  };
}

/** The tags reader over the default credential chain: one DescribeImages call
 *  naming the one image, by digest where the reference carries one. */
export function createEcrImageTagsReader(): EcrImageTagsReader {
  const clientFor = regionalClients();
  return {
    async tagsOf({ registryId, region, repositoryName, tag, digest }) {
      const imageId = digest ? { imageDigest: digest } : { imageTag: tag ?? undefined };
      const answer = await clientFor(region).send(
        new DescribeImagesCommand({ registryId, repositoryName, imageIds: [imageId] }),
      );
      const image = answer.imageDetails?.[0];
      if (!image) throw new Error(`ECR described no image in ${repositoryName}`);
      return image.imageTags ?? [];
    },
  };
}

/** The reader over the default credential chain, one client per region asked. */
export function createEcrImagesReader(): EcrImagesReader {
  const clientFor = regionalClients();
  return {
    async listImages({ registryId, region, repositoryName }) {
      const client = clientFor(region);
      const out: EcrImageRead[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const answer = await client.send(
          new DescribeImagesCommand({ registryId, repositoryName, nextToken, maxResults: 1000 }),
        );
        for (const image of answer.imageDetails ?? []) {
          if (!image.imageDigest) continue;
          out.push({
            digest: image.imageDigest,
            tags: image.imageTags ?? [],
            pushedAt: image.imagePushedAt ? image.imagePushedAt.toISOString() : null,
          });
        }
        nextToken = answer.nextToken;
        if (!nextToken) return out;
      }
      throw new Error(`${repositoryName} holds more images than ${MAX_PAGES} pages read`);
    },
  };
}
