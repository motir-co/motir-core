// The prebuilt image the fixture manifest (`motir.hosting.json` beside this file)
// describes. The manifest schema refuses unknown keys, so the image cannot ride
// inside the manifest; it is the operator deploy check's default image
// (`lib/hosting/deployCheck.ts`, MOTIR-9805), which is the one copy of the pin.
export {
  DEPLOY_CHECK_IMAGE as HOSTING_FIXTURE_IMAGE,
  DEPLOY_CHECK_DEFAULT_MANIFEST as HOSTING_FIXTURE_MANIFEST_PATH,
} from '@/lib/hosting/deployCheck';
