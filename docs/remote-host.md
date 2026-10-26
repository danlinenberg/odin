# Remote host: make an instance Odin can use

Settings > Remote > Remote host lists only EC2 instances tagged `Odin = host`
in the AWS profile and region you pick (under Advanced). **Use** on one of them
does the rest: it gives the instance SSM access, starts it, installs Claude,
gh, tmux and git, and picks it as your host.

So a host needs only two things: an instance, and the tag.

## An instance you already have

Add the tag. Any Ubuntu or Amazon Linux instance works. It needs a way out to
the internet (or to the SSM endpoints), and no open port or SSH key.

```sh
aws --profile <profile> --region <region> ec2 create-tags \
  --resources <instance-id> --tags Key=Odin,Value=host
```

## A new instance from the account's launch template

If the account has an `odin-host` launch template (tagged `Odin = host`), it
fixes the image, role, network and disk, and it tags the instance for you.
Name the instance after yourself:

```sh
aws --profile <profile> --region <region> ec2 run-instances \
  --launch-template LaunchTemplateName=odin-host,Version='$Default' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=odin-<you>}]'
```

Check that it is there and tagged:

```sh
aws --profile <profile> --region <region> ec2 describe-instances \
  --filters Name=tag:Odin,Values=host \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==`Name`]|[0].Value]' \
  --output text
```

Then open Settings > Remote > Remote host, pick the same profile and region
under Advanced, and select **Use** on it. The first setup takes a few minutes.

## It is not in the list

- The profile or region under Advanced is not the instance's.
- The instance has no `Odin = host` tag (the first command above adds it).
- Your AWS sign-in has expired: `aws sso login --profile <profile>`.

## Who can use a host

Anyone whose AWS role has these on instances tagged `Odin = host`:

- `ssm:StartSession`, `ssm:SendCommand` (the `AWS-RunShellScript` document)
  and `ssm:GetCommandInvocation`
- `ec2-instance-connect:SendSSHPublicKey`

With them, Use and the first session set up that user's own Linux user on the
host. Nobody else has to do anything. A role without them gets a session that
stops and says to ask an administrator for them.
