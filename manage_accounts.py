#!/usr/bin/env python3
"""Create a database account locally; passwords are entered without terminal echo."""
import argparse
from getpass import getpass
from pathlib import Path
from device_registry import DeviceRegistry, RegistryError


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,default=Path(__file__).resolve().parent/'data/platform.sqlite3')
    parser.add_argument('--username')
    parser.add_argument('--name')
    parser.add_argument('--role',choices=['admin','company_admin','developer','customer'])
    parser.add_argument('--company',help='例如 company-a；管理员无需指定')
    parser.add_argument('--invite-company',help='生成此公司的单次注册邀请码，7 天有效')
    parser.add_argument('--invite-role',choices=['customer','developer'],default='customer')
    args=parser.parse_args()
    registry=DeviceRegistry(args.database,Path(__file__).resolve().parent,import_demo=False)
    if args.invite_company:
        try:
            token=registry.accounts.invite(args.invite_company,args.invite_role)
        except RegistryError as error:
            parser.error(str(error))
        print(f'公司：{args.invite_company}，身份：{args.invite_role}，7 天内可注册一次。')
        print(f'邀请码：{token}')
        return
    if not all([args.username,args.name,args.role]):
        parser.error('创建账号需指定 --username、--name 和 --role。')
    password=getpass('新密码（12–100 字符）：')
    if password!=getpass('再次输入密码：'):
        parser.error('两次密码不一致。')
    try:
        user=registry.accounts.create(args.username,password,args.name,args.role,args.company)
    except RegistryError as error:
        parser.error(str(error))
    print(f'账号已创建：{user["username"]}（{user["role"]}）')


if __name__=='__main__':
    main()
