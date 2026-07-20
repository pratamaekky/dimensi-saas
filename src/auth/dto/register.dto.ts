import { IsEmail, IsNotEmpty, Matches } from 'class-validator';
import { STRONG_PASSWORD_MESSAGE, STRONG_PASSWORD_REGEX } from '../../common/validators/password';

export class RegisterDto {
  @IsNotEmpty()
  companyName: string;

  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @Matches(STRONG_PASSWORD_REGEX, { message: STRONG_PASSWORD_MESSAGE })
  password: string;
}
