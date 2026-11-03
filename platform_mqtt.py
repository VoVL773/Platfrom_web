"""MQTT device authentication, topic isolation and accepted-message persistence."""
from dataclasses import dataclass
from amqtt.broker import Action
from amqtt.plugins.authentication import BaseAuthPlugin
from amqtt.plugins.topic_checking import BaseTopicPlugin
from device_registry import DeviceRegistry


class DeviceAccessPlugin(BaseAuthPlugin, BaseTopicPlugin):
    @dataclass
    class Config:
        database: str
        root: str
        retention_days: int = 90

    def __init__(self, context):
        super().__init__(context)
        self.registry = DeviceRegistry(self.config.database, self.config.root, import_demo=False,
                                       retention_days=self.config.retention_days)

    async def authenticate(self, *, session):
        return session.client_id == session.username and self.registry.authenticate_device(session.username, session.password)

    async def topic_filtering(self, *, session=None, topic=None, action=None):
        return bool(session and action == Action.PUBLISH and
                    topic == self.registry.topic(session.username) and
                    self.registry.authenticate_device(session.username, session.password))

    async def on_broker_message_broadcast(self, *, client_id, message):
        if message.topic != self.registry.topic(client_id):
            return
        retained = bool(message.publish_packet and message.publish_packet.retain_flag)
        self.registry.ingest(client_id, message.data, retained)
