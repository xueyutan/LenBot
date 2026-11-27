"""Build this Windows overlay from the pinned, unmodified official release ZIP."""
import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
BASE_DIR = 'lenbot-0.4.0-windows-x64'
BASE_SHA256 = '11b3e56274c74c30cc5233a96858fd753849b453151da0b76117ae9ff64d0847'


def build(base: Path, output: Path) -> None:
    if output.suffix.lower() != '.zip' or output.exists():
        raise ValueError('output must be a new .zip file')
    with base.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != BASE_SHA256:
            raise ValueError('SHA-256 mismatch: use the official LenBot 0.4.0 Windows x64 ZIP')
        stream.seek(0)
        with tempfile.TemporaryDirectory(prefix='lenbot-040-') as scratch:
            stage = Path(scratch)
            with ZipFile(stream) as archive:
                archive.extractall(stage)
            target = stage / BASE_DIR
            shutil.copytree(HERE / 'patches', target / 'patches')
            for mode in ('--apply', '--check'):
                subprocess.run([sys.executable, '-B', '-X', 'utf8', str(target/'patches/reapply.py'), mode,
                                '--root', str(target)], check=True)
            # The fresh official ZIP has no patch backups; do not distribute copies left by replay.
            for backup in target.rglob('*.bak-reapply-*'):
                backup.unlink()
            shutil.copytree(HERE / 'overlay', target, dirs_exist_ok=True)
            output.parent.mkdir(parents=True, exist_ok=True)
            generated = shutil.make_archive(str(stage / 'package'), 'zip', root_dir=stage, base_dir=BASE_DIR)
            shutil.copyfile(generated, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('official_zip', type=Path)
    parser.add_argument('output_zip', type=Path)
    args = parser.parse_args()
    try:
        build(args.official_zip, args.output_zip)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
