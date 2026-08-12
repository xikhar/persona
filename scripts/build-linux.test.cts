import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxPackagingCommand } from './build-linux.cjs';

test("uses system FPM through Nix on NixOS and bundled FPM elsewhere", () => {
  const nix = linuxPackagingCommand({ nixos: true });
  assert.equal(nix.command, "nix");
  assert.ok(nix.args.includes("nixpkgs#fpm"));
  assert.ok(nix.args.includes("USE_SYSTEM_FPM=true"));

  const standard = linuxPackagingCommand({ nixos: false });
  assert.match(standard.command, /electron-builder$/);
  assert.deepEqual(standard.args, ["--linux", "AppImage", "deb", "--publish", "never"]);
});
