// apps/api/src/modules/queue/queue.gateway.ts
//
// ROADMAP — Épica 2. Es al WebSocket lo que un Controller es a HTTP:
// el punto de entrada. Pero en vez de responder una vez y olvidarse,
// mantiene conexiones abiertas y puede "hablarles" cuando algo cambia.

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { QueueRequest } from './entities/queue-request.entity';

@WebSocketGateway({
  cors: { origin: '*' }, // en producción, restringir al dominio real del frontend
})
export class QueueGateway {
  // Nest inyecta aquí el servidor de Socket.io completo — es el
  // objeto que usamos para "gritarle" a todos los conectados.
  @WebSocketServer()
  server!: Server;

  // Se ejecuta cuando la pantalla del DJ dice "quiero escuchar la
  // cola de ESTE venue". 'rooms' de Socket.io = agrupar conexiones
  // por tema, así el venue A nunca recibe avisos del venue B.
  @SubscribeMessage('queue:join')
  handleJoin(
    @MessageBody() venueId: string,
    @ConnectedSocket() client: Socket,
  ): void {
    client.join(`venue:${venueId}`);
  }

  // El método que QueueService va a llamar después de guardar un
  // pedido nuevo — le avisa SOLO a quien esté escuchando ESE venue.
  notifyQueueUpdated(venueId: string, queue: QueueRequest[]): void {
    this.server.to(`venue:${venueId}`).emit('queue:updated', queue);
  }
}
