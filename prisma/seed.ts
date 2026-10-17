/**
 * Static demo data for trying the customers/conversations endpoints without
 * WhatsApp. Safe to run repeatedly: everything is keyed by fixed ids or by
 * the unique keys (businessId + phone), and messages are only inserted into
 * conversations that are still empty (so timestamps never shift on re-runs).
 *
 *   npx prisma db seed
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConversationChannel,
  ConversationStatus,
  MessageSenderType as Sender,
  PrismaClient,
} from '../src/generated/prisma/client';

export const SEED_BUSINESS_A = 'a0000000-0000-4000-8000-000000000001';
export const SEED_BUSINESS_B = 'b0000000-0000-4000-8000-000000000002';

type SeedMessage = { from: Sender; text: string; wamid?: string };
type SeedCustomer = {
  phone: string;
  name?: string;
  status: ConversationStatus;
  messages: SeedMessage[];
};

const businessA: SeedCustomer[] = [
  {
    phone: '201000000001',
    name: 'Sara',
    status: ConversationStatus.OPEN,
    messages: [
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_1_1',
        text: 'السلام عليكم، عندكم تيشيرت أسود؟',
      },
      { from: Sender.AI, text: 'وعليكم السلام! أيوه موجود، تحبي مقاس إيه؟' },
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_1_2',
        text: 'XL لو سمحتي. بكام؟',
      },
      { from: Sender.OWNER, text: 'السعر ٢٩٩ جنيه والتوصيل بكرة إن شاء الله.' },
    ],
  },
  {
    phone: '201000000002',
    name: 'Omar',
    status: ConversationStatus.CLOSED,
    messages: [
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_2_1',
        text: 'عايز أرجّع منتج اشتريته امبارح',
      },
      { from: Sender.AI, text: 'تمام، ممكن توضحلي رقم الطلب؟' },
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_2_2',
        text: 'شكراً، اتحلت المشكلة.',
      },
    ],
  },
  {
    phone: '201000000003',
    name: 'John',
    status: ConversationStatus.OPEN,
    messages: [
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_3_1',
        text: 'Hi, do you have the black hoodie in size L?',
      },
      {
        from: Sender.AI,
        text: 'Yes, we do! Would you like to place an order?',
      },
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_3_2',
        text: 'Yes please, one hoodie.',
      },
    ],
  },
  {
    // WhatsApp does not always send a profile name.
    phone: '201000000004',
    status: ConversationStatus.OPEN,
    messages: [
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_A_4_1',
        text: 'ممكن أعرف مواعيد الشغل؟',
      },
    ],
  },
];

// Same phone as Sara on purpose: unique per business, not globally.
const businessB: SeedCustomer[] = [
  {
    phone: '201000000001',
    name: 'Mona',
    status: ConversationStatus.OPEN,
    messages: [
      {
        from: Sender.CUSTOMER,
        wamid: 'wamid.SEED_B_1_1',
        text: 'Hello from the other business',
      },
    ],
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    await seedBusiness(
      prisma,
      SEED_BUSINESS_A,
      'Brandora Demo Store',
      businessA,
    );
    await seedBusiness(prisma, SEED_BUSINESS_B, 'Demo Store B', businessB);
    console.log(
      `Seeded businesses:\n  A ${SEED_BUSINESS_A}\n  B ${SEED_BUSINESS_B}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function seedBusiness(
  prisma: PrismaClient,
  businessId: string,
  name: string,
  customers: SeedCustomer[],
): Promise<void> {
  await prisma.business.upsert({
    where: { id: businessId },
    create: { id: businessId, name, category: 'Fashion' },
    update: {},
  });
  // Messages start 24h ago, so anything you send later through the dev
  // endpoint is newer than the seeded history (lists sort by time).
  const base = Date.now() - 24 * 60 * 60_000;
  for (const [i, c] of customers.entries()) {
    const customer = await prisma.customer.upsert({
      where: { businessId_phone: { businessId, phone: c.phone } },
      create: { businessId, phone: c.phone, name: c.name },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        businessId_customerId_channel: {
          businessId,
          customerId: customer.id,
          channel: ConversationChannel.WHATSAPP,
        },
      },
      create: {
        businessId,
        customerId: customer.id,
        channel: ConversationChannel.WHATSAPP,
        status: c.status,
      },
      update: {},
    });
    if (
      (await prisma.message.count({
        where: { conversationId: conversation.id },
      })) > 0
    )
      continue;
    await prisma.message.createMany({
      data: c.messages.map((m, j) => ({
        conversationId: conversation.id,
        senderType: m.from,
        externalMessageId: m.wamid ?? null,
        content: m.text,
        createdAt: new Date(base + (i * 60 + j) * 60_000),
      })),
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
