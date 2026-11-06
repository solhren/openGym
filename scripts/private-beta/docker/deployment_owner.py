"""Deployment-file ownership guard shared by the two offline patch tools."""
import os
import pwd


def verify_deployment_owner(root):
    uid = os.geteuid()
    current = pwd.getpwuid(uid).pw_name
    explicit = os.environ.get('OPENGYM_DEPLOY_OWNER')
    owner = explicit if explicit is not None else current
    if (uid != os.getuid() or owner != current or root.stat().st_uid != uid
            or os.environ.get('SUDO_USER') or os.environ.get('SUDO_UID')
            or (uid == 0 and explicit != current)):
        raise ValueError('Run as OPENGYM_DEPLOY_OWNER (defaults to the current user), without sudo; root requires explicit ownership')
    return uid
