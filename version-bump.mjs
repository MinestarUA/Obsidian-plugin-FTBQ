import { readFileSync, writeFileSync } from "node:fs";

// `npm version <x.y.z>`: copies the version into manifest.json and records minAppVersion in versions.json.
// npm 11 no longer exports npm_package_version to lifecycle scripts reliably, so read package.json.
const targetVersion = process.env.npm_package_version ?? JSON.parse(readFileSync("package.json", "utf8")).version;
if (!targetVersion) throw new Error("No version found in package.json");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = manifest.minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}
