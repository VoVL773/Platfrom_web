#!/usr/bin/env python3
"""Generate an isolated test CA and server certificate. Never install a trust root."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import subprocess


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'data/tls-local')
    parser.add_argument('--host',action='append',default=[],help='额外域名或局域网 IP，可重复指定')
    args=parser.parse_args()
    hosts=['localhost','127.0.0.1',*args.host]
    san=[]
    for host in hosts:
        try:
            ipaddress.ip_address(host);san.append('IP:'+host)
        except ValueError:
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}',host):parser.error('host 必须为 IP 或域名')
            san.append('DNS:'+host)
    if args.output.exists():parser.error('输出目录已存在，请指定新目录，避免覆盖现有密钥。')
    args.output.mkdir(parents=True,mode=0o700)
    os.umask(0o077)
    def openssl(*command):
        subprocess.run(['openssl',*command],cwd=args.output,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    (args.output/'server.ext').write_text('subjectAltName='+','.join(san)+'\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','root-ca.pem','-days','365',
            '-subj','/CN=RD Local Test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
    openssl('req','-newkey','rsa:2048','-nodes','-keyout','server-key.pem','-out','server.csr','-subj','/CN=localhost')
    openssl('x509','-req','-in','server.csr','-CA','root-ca.pem','-CAkey','ca-key.pem','-CAcreateserial',
            '-out','server-cert.pem','-days','90','-sha256','-extfile','server.ext')
    print(f'测试证书已生成：{args.output.resolve()}（未修改系统信任设置）')


if __name__=='__main__':main()
