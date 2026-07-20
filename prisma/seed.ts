import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const companyA = await prisma.company.create({ data: { name: 'Acme Corp' } });
  await prisma.user.create({
    data: {
      companyId: companyA.id,
      email: 'admin@acme.test',
      passwordHash,
      name: 'Acme Admin',
      role: Role.ADMIN,
    },
  });

  const companyB = await prisma.company.create({ data: { name: 'Globex Inc' } });
  await prisma.user.create({
    data: {
      companyId: companyB.id,
      email: 'admin@globex.test',
      passwordHash,
      name: 'Globex Admin',
      role: Role.ADMIN,
    },
  });

  console.log('Seeded: admin@acme.test / admin@globex.test, password: password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
