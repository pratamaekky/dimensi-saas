import { IsEmail, IsEnum, IsNotEmpty, IsOptional, Matches } from 'class-validator';
import { Role } from '@prisma/client';
import { STRONG_PASSWORD_MESSAGE, STRONG_PASSWORD_REGEX } from '../../common/validators/password';

export class CreateUserDto {
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @Matches(STRONG_PASSWORD_REGEX, { message: STRONG_PASSWORD_MESSAGE })
  password: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
