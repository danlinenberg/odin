import { describe, expect, test } from "bun:test";
import {
	hostPackagesProblem,
	hostPolicyArnProblem,
	packageNames,
} from "./host-setup";

describe("host-setup", () => {
	test("an IAM policy ARN passes: the account's own or one of AWS's, empty for none", () => {
		expect(
			hostPolicyArnProblem("arn:aws:iam::123456789012:policy/odin-host"),
		).toBeNull();
		expect(
			hostPolicyArnProblem(
				" arn:aws:iam::123456789012:policy/team/Odin_Host.v2+read@x ",
			),
		).toBeNull();
		expect(
			hostPolicyArnProblem("arn:aws:iam::aws:policy/SecretsManagerReadWrite"),
		).toBeNull();
		expect(hostPolicyArnProblem("")).toBeNull();
	});

	test("anything else is refused, in one line", () => {
		for (const text of [
			"odin-host",
			"arn:aws:iam::12345:policy/odin-host",
			"arn:aws:iam::123456789012:role/odin-host",
			"arn:aws:s3:::bucket",
			"arn:aws:iam::123456789012:policy/odin host",
			"arn:aws:iam::123456789012:policy/",
		])
			expect(hostPolicyArnProblem(text)).toBe(
				"Not an IAM policy ARN: arn:aws:iam::<account id>:policy/<name>.",
			);
	});

	test("package names: letters, digits and . + - _, once each", () => {
		expect(
			packageNames(
				" awscli jq  mysql-client mongosh jq g++ libc6_dev python3.12\n",
			),
		).toEqual([
			"awscli",
			"jq",
			"mysql-client",
			"mongosh",
			"g++",
			"libc6_dev",
			"python3.12",
		]);
		expect(packageNames("")).toEqual([]);
		expect(hostPackagesProblem("awscli jq")).toBeNull();
	});

	test("a name the shell or the package manager would read as something else is refused", () => {
		for (const text of [
			"jq; rm -rf /",
			"jq $(id)",
			"--reinstall jq",
			"-y",
			"jq 'x'",
			"a/b",
		]) {
			expect(hostPackagesProblem(text)).toMatch(/^Not a package name: /);
			expect(() => packageNames(text)).toThrow("Not a package name: ");
		}
		expect(hostPackagesProblem("jq; rm -rf /")).toBe(
			"Not a package name: jq;. Letters, digits and . + - _ only, separated by spaces.",
		);
	});
});
