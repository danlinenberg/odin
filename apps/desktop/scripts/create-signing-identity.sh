#!/usr/bin/env bash
#
# Creates the self-signed certificate that Odin builds are signed with.
#
# macOS TCC keys every privacy grant to the app's code signature. Ad-hoc signing
# produces a fresh signature on every build, so macOS forgets everything you
# allowed and prompts again. A stable certificate keeps the designated
# requirement identical across rebuilds, so the grants stick.
#
# Idempotent: re-running is a no-op once the identity exists. To start over,
# `security delete-keychain odin-signing.keychain-db` and run this again — that
# resets the signature, so macOS will ask for permissions once more.
set -euo pipefail

IDENTITY="Odin Local Signing"
KEYCHAIN_NAME="odin-signing.keychain-db"
KEYCHAIN="$HOME/Library/Keychains/$KEYCHAIN_NAME"
# Not a secret: this keychain holds one self-signed cert that vouches for
# nothing. It exists so signing needs no prompt and no login-keychain password.
KEYCHAIN_PASSWORD="odin-signing"

if security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
	echo "Signing identity already present: $IDENTITY"
	exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [[ ! -f "$KEYCHAIN" ]]; then
	security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
fi
security set-keychain-settings "$KEYCHAIN" # no auto-lock, no timeout
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

# Reuse the existing certificate if a previous run got as far as importing one
# (the trust step below can be cancelled). Minting a second cert would change the
# signature — the exact thing this script exists to keep stable.
if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
	echo "Reusing the certificate from an earlier run."
else
	cat >"$tmp/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

	# /usr/bin/openssl, not whatever is on PATH: Homebrew's OpenSSL 3 defaults to
	# PKCS#12 algorithms that `security import` rejects with "MAC verification
	# failed". The explicit -*pbe/-macalg flags keep the bundle readable either way.
	/usr/bin/openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
		-keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/openssl.cnf" 2>/dev/null
	/usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
		-out "$tmp/identity.p12" -passout "pass:$KEYCHAIN_PASSWORD" -name "$IDENTITY" \
		-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1

	security import "$tmp/identity.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASSWORD" \
		-T /usr/bin/codesign -T /usr/bin/security
	# Without this, every codesign call pops a keychain-access dialog.
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
		-k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1
fi

security find-certificate -c "$IDENTITY" -p "$KEYCHAIN" >"$tmp/cert.pem"
# codesign is happy with an untrusted cert, but electron-builder only picks
# identities that `security find-identity -v` calls valid, which means trusted.
# Trusting a certificate is the one step macOS wants a password for.
if [[ -n "${CI:-}" ]]; then
	# No one is there to type a password, and no GUI session owns the user trust
	# settings — but sudo is passwordless on hosted runners, so trust it system-wide.
	sudo security add-trusted-cert -d -r trustRoot -p codeSign \
		-k /Library/Keychains/System.keychain "$tmp/cert.pem"
else
	echo "macOS will now ask for your login password to trust the certificate..."
	security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem"
fi

# Put the keychain on the search list so codesign can find the identity,
# keeping whatever is already there.
existing=()
while IFS= read -r line; do
	line="${line#"${line%%[![:space:]]*}"}"
	line="${line%\"}"
	line="${line#\"}"
	[[ "$line" == "$KEYCHAIN" ]] || existing+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "${existing[@]}" "$KEYCHAIN"

security find-identity -v -p codesigning | grep -F "$IDENTITY"
echo "Created signing identity: $IDENTITY"
