import Stripe from "stripe";
import { Request, Response } from "express";
import Restaurant, { MenuItemType } from "../models/restaurant";
import Order from "../models/order";

const STRIPE = new Stripe(process.env.STRIPE_API_KEY as string);
const FRONTEND_URL = process.env.FRONTEND_URL as string;
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;

const getMyOrders = async (req: Request, res: Response) => {
    try {
      const orders = await Order.find({ user: req.userId })
        .populate("restaurant")
        .populate("user");
  
      res.json(orders);
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "something went wrong" });
    }
  };

type CheckoutSessionRequest = {
    cartItems: {
      menuItemId: string;
      name: string;
      quantity: string;
    }[];
    deliveryDetails: {
      email: string;
      name: string;
      addressLine1: string;
      city: string;
    };
    restaurantId: string;
  };

const stripeWebhookHandler = async (req: Request, res: Response) => {
    let event;

    console.log("💰 Webhook endpoint hit");

    try {
      
      const sig = req.headers["stripe-signature"];
      
      if (!sig) {
        console.error("No Stripe signature found");
        return res.status(400).send("Missing stripe-signature header");
      }
      
      console.log("Signature received:", sig);
      
   
      event = STRIPE.webhooks.constructEvent(
        req.body, 
        sig as string,
        STRIPE_ENDPOINT_SECRET
      );
      
      console.log("🔍 Webhook signature verified, event type:", event.type);
      
    } catch (error: any) {
      console.log(`⚠️ Webhook signature verification failed: ${error.message}`);
      return res.status(400).send(`Webhook error: ${error.message}`);
    }
    
 
    if (event.type === "checkout.session.completed") {
      try {
        const order = await Order.findById(event.data.object.metadata?.orderId);
    
        if (!order) {
          console.error("Order not found:", event.data.object.metadata?.orderId);
          return res.status(404).json({ message: "Order not found" });
        }
    
        order.totalAmount = event.data.object.amount_total;
        order.status = "paid";
    
        await order.save();
        console.log(`✅ Order ${order._id} updated to paid status`);
      } catch (error: any) {
        console.error("Error updating order:", error);
       
      }
    }
    
    res.status(200).json({ received: true });
};

const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const checkoutSessionRequest: CheckoutSessionRequest = req.body;

    const restaurant = await Restaurant.findById(
      checkoutSessionRequest.restaurantId
    );

    if (!restaurant) {
      throw new Error("Restaurant not found");
    }

    const newOrder = new Order({
        restaurant: restaurant,
        user: req.userId,
        status: "placed",
        deliveryDetails: checkoutSessionRequest.deliveryDetails,
        cartItems: checkoutSessionRequest.cartItems,
        totalAmount: 0,
        createdAt: new Date(),
      });


    const lineItems = createLineItems(
      checkoutSessionRequest,
      restaurant.menuItems
    );

    const session = await createSession(
        lineItems,
        newOrder._id.toString(),
        restaurant.deliveryPrice,
        restaurant._id.toString()
      );

      if (!session.url) {
        return res.status(500).json({ message: "Error creating stripe session" });
      }

      await newOrder.save();
      res.json({ url: session.url });
  } catch (error: any) {
    console.log(error);
    res.status(500).json({ 
      message: error.raw?.message || error.message || "Error creating checkout session" 
    });
  }
};

const createLineItems = (
    checkoutSessionRequest: CheckoutSessionRequest,
    menuItems: MenuItemType[]
  ) => {
    const lineItems = checkoutSessionRequest.cartItems.map((cartItem) => {
      const menuItem = menuItems.find(
        (item) => item._id.toString() === cartItem.menuItemId.toString()
      );
  
      if (!menuItem) {
        throw new Error(`Menu item not found: ${cartItem.menuItemId}`);
      }
  
      const line_item: Stripe.Checkout.SessionCreateParams.LineItem = {
        price_data: {
          currency: "CAD",
          unit_amount: menuItem.price,
          product_data: {
            name: menuItem.name,
          },
        },
        quantity: parseInt(cartItem.quantity),
      };
  
      return line_item;
    });
  
    return lineItems;
  };

    const createSession = async (
        lineItems: Stripe.Checkout.SessionCreateParams.LineItem[],
        orderId: string,
        deliveryPrice: number,
        restaurantId: string
      ) => {
        const sessionData = await STRIPE.checkout.sessions.create({
          line_items: lineItems,
          shipping_options: [
            {
              shipping_rate_data: {
                display_name: "Delivery",
                type: "fixed_amount",
                fixed_amount: {
                  amount: deliveryPrice,
                  currency: "CAD",
                },
              },
            },
          ],
          mode: "payment",
          metadata: {
            orderId,
            restaurantId,
          },
          success_url: `${FRONTEND_URL}/order-status?success=true`,
          cancel_url: `${FRONTEND_URL}/detail/${restaurantId}?cancelled=true`,
        });
      
        return sessionData;
      };

export default {
  getMyOrders,
  createCheckoutSession,
  stripeWebhookHandler,
};