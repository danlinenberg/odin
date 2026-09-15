import type { HostAuthProvider } from "../../src/providers/host-auth";
import type { ModelProviderRuntimeResolver } from "../../src/providers/model-providers";
import type { GitCredentialProvider } from "../../src/runtime/git/types";

export class FakeHostAuthProvider implements HostAuthProvider {
	constructor(private readonly psk: string) {}
	validate(request: Request): boolean {
		const header = request.headers.get("authorization");
		const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
		return token === this.psk;
	}
	validateToken(token: string): boolean {
		return token === this.psk;
	}
}

export class MemoryGitCredentialProvider implements GitCredentialProvider {
	constructor(private readonly token: string | null = null) {}
	async getCredentials(): Promise<{ env: Record<string, string> }> {
		return { env: {} };
	}
	async getToken(): Promise<string | null> {
		return this.token;
	}
}

export class FakeModelResolver implements ModelProviderRuntimeResolver {
	async hasUsableRuntimeEnv(): Promise<boolean> {
		return true;
	}
	async prepareRuntimeEnv(): Promise<void> {}
}
